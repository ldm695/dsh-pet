/**
 * Standalone settings application composed from the shared React pet settings and AI controls.
 * @module dsh-pet/src/standalone/settings-page/settings-app-mount
 */
import {
  createElement as h,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FC,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { jsx } from 'react/jsx-runtime';
import { makePetConfigSection } from '../../client/settings.ts';
import { zh as settingsZh } from '../../client/settings/locales/zh.ts';
import { makePetChatPanel } from '../../client/chat/panel.ts';
import { zh as chatZh } from '../../client/chat/locales/index.ts';
import type { ChatPanelRuntime } from '../../client/chat/runtime.ts';
import type { SettingsRuntime } from '../../client/settings/runtime.ts';
import { ROUTE_SEGMENT } from '../../shared/constants.ts';
import { createTranslator } from './translate.ts';

type AiSettings = {
  protocol: 'openai-compatible' | 'anthropic' | 'deepseek-official';
  baseUrl: string;
  model: string;
  balanceProvider: string;
  hasKey: boolean;
  hasDeepseekKey: boolean;
  chatEnabled: boolean;
  automaticWhispers: boolean;
  whispersOnlyOffPeak: boolean;
  chatMemoryRounds: number;
  chatImageLimit: number;
};

type ModelOption = { id: string; name?: string };

const API = ROUTE_SEGMENT;
const TOKEN = new URLSearchParams(location.hash.slice(1)).get('token') || '';
history.replaceState(null, '', location.pathname);

async function request<T>(path: string, method = 'GET', body?: unknown, pluginRoute = true): Promise<T> {
  const response = await fetch((pluginRoute ? API : '') + path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers:
      body === undefined
        ? { 'X-DSH-Pet-Token': TOKEN }
        : { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as T | { error?: string; message?: string } | null;
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error || payload.message : undefined;
    throw new Error(
      detail ||
        (response.status === 403
          ? '打开凭据已失效，请从桌宠菜单重新打开设置。'
          : `请求失败（HTTP ${response.status}）`),
    );
  }
  return payload as T;
}

const settingsRuntime: SettingsRuntime = {
  h: jsx,
  useState,
  useEffect,
  useRef,
  useCallback,
  stylesInjected: true,
  t: (key) => String(settingsZh[key as keyof typeof settingsZh] ?? key),
};

const chatRuntime: ChatPanelRuntime = {
  h: jsx as ChatPanelRuntime['h'],
  useState,
  useEffect,
  useRef,
  t: createTranslator(chatZh),
};

const PetConfigSection = makePetConfigSection(settingsRuntime, { get: () => undefined });
const PetChatPanel = makePetChatPanel(chatRuntime) as unknown as FC;

function statusClass(kind: 'ok' | 'error' | ''): string {
  return `status${kind ? ` status-${kind}` : ''}`;
}

function Field(props: { label: string; children?: ReactNode; hint?: string }): ReactNode {
  return h('div', { className: 'field' }, [
    h('label', { className: 'fieldLabel' }, props.label),
    props.children,
    props.hint ? h('p', { className: 'fieldHint' }, props.hint) : null,
  ]);
}

function Check(props: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}): ReactNode {
  return h('label', { className: 'checkRow' }, [
    h('input', {
      type: 'checkbox',
      checked: props.checked,
      disabled: props.disabled,
      onChange: (event: ChangeEvent<HTMLInputElement>) => props.onChange(event.currentTarget.checked),
    }),
    h('span', null, [props.label, props.hint ? h('small', { className: 'fieldHint checkHint' }, props.hint) : null]),
  ]);
}

function Card(props: { title: string; hint?: string; children?: ReactNode }): ReactNode {
  return h('section', { className: 'card' }, [
    h('div', { className: 'cardHead' }, h('h2', { className: 'cardTitle' }, props.title)),
    props.hint ? h('p', { className: 'cardHint' }, props.hint) : null,
    props.children,
  ]);
}

function useRecovery(): {
  info: { backupDirectory: string; fileCount: number; totalBytes: number } | null;
  status: string;
  kind: 'ok' | 'error' | '';
  open: () => void;
  restore: () => void;
} {
  const [info, setInfo] = useState<{ backupDirectory: string; fileCount: number; totalBytes: number } | null>(null);
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState<'ok' | 'error' | ''>('');
  useEffect(() => {
    let active = true;
    void request<{ available: boolean; backupDirectory?: string; fileCount?: number; totalBytes?: number }>(
      '/migration-recovery',
    )
      .then((value) => {
        if (active && value.available)
          setInfo({
            backupDirectory: value.backupDirectory || '',
            fileCount: value.fileCount || 0,
            totalBytes: value.totalBytes || 0,
          });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const open = useCallback(() => {
    setStatus('正在打开原配置文件夹…');
    setKind('');
    void request('/migration-recovery/open', 'POST', {})
      .then(() => {
        setStatus('已打开原配置文件夹。');
        setKind('ok');
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
        setKind('error');
      });
  }, []);
  const restore = useCallback(() => {
    if (
      !info ||
      !window.confirm(
        `还原原配置会移除当前桌宠配置、恢复迁移前备份，并立即退出程序。\n备份目录：\n${info.backupDirectory}\n\n确定继续吗？`,
      )
    )
      return;
    setStatus('正在还原原配置并退出…');
    setKind('');
    void request('/migration-recovery/restore', 'POST', {}).catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : String(error));
      setKind('error');
    });
  }, [info]);
  return { info, status, kind, open, restore };
}

function RecoveryCard(): ReactNode {
  const recovery = useRecovery();
  if (!recovery.info) return null;
  return h(Card, { title: '迁移异常备份', hint: '检测到上游配置迁移异常，原配置已完整备份。' }, [
    h(
      'p',
      { className: 'fieldHint' },
      `备份包含 ${recovery.info.fileCount} 个文件，共 ${recovery.info.totalBytes.toLocaleString()} 字节：${recovery.info.backupDirectory}`,
    ),
    h('div', { className: 'testRow' }, [
      h('button', { className: 'btn ghost', type: 'button', onClick: recovery.open }, '打开原配置文件夹'),
      h('button', { className: 'btn danger', type: 'button', onClick: recovery.restore }, '还原原配置'),
      h('span', { className: statusClass(recovery.kind), role: 'status', 'aria-live': 'polite' }, recovery.status),
    ]),
  ]);
}

function AiSettings(): ReactNode {
  const [saved, setSaved] = useState<AiSettings | null>(null);
  const [protocol, setProtocol] = useState<AiSettings['protocol']>('openai-compatible');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [balanceProvider, setBalanceProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [chatEnabled, setChatEnabled] = useState(true);
  const [automaticWhispers, setAutomaticWhispers] = useState(false);
  const [whispersOnlyOffPeak, setWhispersOnlyOffPeak] = useState(false);
  const [chatMemoryRounds, setChatMemoryRounds] = useState(5);
  const [chatImageLimit, setChatImageLimit] = useState(10);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('正在读取本机设置…');
  const [kind, setKind] = useState<'ok' | 'error' | ''>('');
  const [test, setTest] = useState('');
  const [balance, setBalance] = useState('');
  const [dialog, setDialog] = useState<'api' | 'voice' | null>(null);
  const apply = useCallback((data: AiSettings) => {
    setSaved(data);
    setProtocol(data.protocol);
    setBaseUrl(data.baseUrl);
    setModel(data.model);
    setBalanceProvider(data.balanceProvider);
    setChatEnabled(data.chatEnabled !== false);
    setAutomaticWhispers(data.automaticWhispers === true);
    setWhispersOnlyOffPeak(data.whispersOnlyOffPeak === true);
    setChatMemoryRounds(data.chatMemoryRounds ?? 5);
    setChatImageLimit(data.chatImageLimit ?? 10);
    setApiKey('');
    setDeepseekApiKey('');
  }, []);
  useEffect(() => {
    let active = true;
    void request<AiSettings>('/standalone-ai/settings', 'GET', undefined, false)
      .then((data) => {
        if (active) {
          apply(data);
          setStatus('设置仅保存在本机。');
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setStatus(error instanceof Error ? error.message : String(error));
          setKind('error');
        }
      });
    return () => {
      active = false;
    };
  }, [apply]);
  const setMessage = (message: string, type: 'ok' | 'error' | '' = '') => {
    setStatus(message);
    setKind(type);
  };
  const discover = async () => {
    setBusy(true);
    setTest('正在读取模型列表…');
    try {
      const result = await request<{ ok: boolean; models?: ModelOption[]; message?: string }>(
        '/standalone-ai/models',
        'POST',
        { protocol, baseUrl, apiKey },
        false,
      );
      if (!result.ok) throw new Error(result.message || '模型列表读取失败。');
      setModels(result.models || []);
      setTest(`读取到 ${(result.models || []).length} 个模型。`);
    } catch (error) {
      setTest(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('正在保存到本机…');
    try {
      const data = await request<AiSettings>(
        '/standalone-ai/settings',
        'POST',
        {
          protocol,
          baseUrl,
          model,
          balanceProvider,
          apiKey,
          deepseekApiKey,
          chatEnabled,
          automaticWhispers,
          whispersOnlyOffPeak,
          chatMemoryRounds,
          chatImageLimit,
        },
        false,
      );
      apply(data);
      setMessage('已保存到本机。', 'ok');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const clearKey = async () => {
    if (!dialog) return;
    const clearApiKey = dialog === 'api';
    setBusy(true);
    try {
      const data = await request<AiSettings>(
        '/standalone-ai/settings',
        'POST',
        { ...(clearApiKey ? { clearApiKey: true, chatEnabled: false } : { clearDeepseekKey: true }) },
        false,
      );
      apply(data);
      setDialog(null);
      setMessage(clearApiKey ? '已删除密钥，并关闭 AI 对话。' : '已删除语音密钥。', 'ok');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const testConnection = async () => {
    setBusy(true);
    setTest('正在测试连接…');
    try {
      const result = await request<{ ok: boolean; message?: string; reply?: string }>(
        '/standalone-ai/test',
        'POST',
        { protocol, baseUrl, model, apiKey },
        false,
      );
      setTest(
        result.ok
          ? `✓ ${result.message || '连接成功'}${result.reply ? `；回复：${result.reply}` : ''}`
          : `✗ ${result.message || '测试失败'}`,
      );
    } catch (error) {
      setTest(`✗ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const queryBalance = async () => {
    setBusy(true);
    setBalance('正在查询余额…');
    try {
      const result = await request<{
        ok: boolean;
        shape?: string;
        data?: Record<string, unknown>;
        message?: string;
        reason?: string;
      }>('/standalone-ai/balance', 'POST', {}, false);
      const data = result.data || {};
      const text =
        result.shape === 'money' && Array.isArray(data.wallets)
          ? (data.wallets as { currency: string; total: string }[])
              .map((wallet) => `${wallet.currency} ${wallet.total}`)
              .join(' / ')
          : result.shape === 'points'
            ? `${data.total} ${data.unit}`
            : result.message ||
              (result.ok
                ? '已取到余额数据。'
                : result.reason === 'unsupported'
                  ? '该服务商不提供余额查询。'
                  : '查询失败。');
      setBalance(`${result.ok ? '✓' : '✗'} ${text}`);
    } catch (error) {
      setBalance(`✗ ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const clearDialog = dialog
    ? h(
        'div',
        { className: 'dialogMask', role: 'presentation' },
        h(
          'section',
          { className: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'ai-dialog-title' },
          [
            h(
              'h2',
              { className: 'dialogTitle', id: 'ai-dialog-title' },
              dialog === 'api' ? '删除已保存的密钥？' : '删除已保存的语音密钥？',
            ),
            h(
              'p',
              { className: 'dialogText' },
              dialog === 'api'
                ? '删除后桌宠将无法调用模型，并会关闭 AI 对话。要恢复使用，需要重新填写密钥。'
                : '删除后 DeepSeek 语音功能不可用，直到重新填写密钥。',
            ),
            h('div', { className: 'dialogActions' }, [
              h('button', { className: 'btn', type: 'button', onClick: () => setDialog(null) }, '取消'),
              h('button', { className: 'btn danger', type: 'button', disabled: busy, onClick: clearKey }, '确认删除'),
            ]),
          ],
        ),
      )
    : null;
  const protocolChanged = (value: AiSettings['protocol']) => {
    setProtocol(value);
    if (value === 'deepseek-official') setBaseUrl('https://api.deepseek.com');
    setModels([]);
  };
  const official = protocol === 'deepseek-official';
  return h('form', { onSubmit: save, className: 'standalone-ai-form' }, [
    h(Card, { title: '模型连接', hint: '配置独立模式使用的模型服务。API 密钥只保存在本机。' }, [
      h(
        Field,
        { label: '接口协议' },
        h(
          'select',
          {
            'aria-label': '接口协议',
            value: protocol,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              protocolChanged(event.currentTarget.value as AiSettings['protocol']),
          },
          [
            h('option', { value: 'openai-compatible' }, 'OpenAI 兼容'),
            h('option', { value: 'anthropic' }, 'Anthropic'),
            h('option', { value: 'deepseek-official' }, 'DeepSeek'),
          ],
        ),
      ),
      h(
        Field,
        {
          label: '接口地址（Base URL）',
          hint: official
            ? 'DeepSeek 使用固定官方地址。'
            : '填写服务商提供的 HTTP 或 HTTPS 接口地址，不要把密钥写进地址。',
        },
        h('input', {
          'aria-label': '接口地址（Base URL）',
          type: 'url',
          value: baseUrl,
          readOnly: official,
          maxLength: 2048,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
            setBaseUrl(event.currentTarget.value);
            setModels([]);
          },
        }),
      ),
      h('div', { className: 'grid2' }, [
        h(
          Field,
          { label: '模型名称' },
          h('div', { className: 'combo' }, [
            h('input', {
              'aria-label': '模型名称',
              type: 'text',
              value: model,
              maxLength: 200,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => setModel(event.currentTarget.value),
            }),
            h('button', { className: 'btn', type: 'button', disabled: busy, onClick: discover }, '获取模型'),
          ]),
        ),
        h(
          Field,
          { label: saved?.hasKey ? 'API 密钥（已保存，不回显）' : 'API 密钥', hint: '留空会保留已保存的密钥。' },
          h('input', {
            'aria-label': 'API 密钥',
            type: 'password',
            autoComplete: 'new-password',
            value: apiKey,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => setApiKey(event.currentTarget.value),
            placeholder: '输入新密钥（可留空）',
          }),
        ),
      ]),
      models.length
        ? h(
            Field,
            { label: '可用模型' },
            h(
              'select',
              {
                value: '',
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                  if (event.currentTarget.value) setModel(event.currentTarget.value);
                },
              },
              [
                h('option', { value: '' }, '选择模型…'),
                ...models.map((entry) =>
                  h(
                    'option',
                    { key: entry.id, value: entry.id },
                    entry.name && entry.name !== entry.id ? `${entry.name}（${entry.id}）` : entry.id,
                  ),
                ),
              ],
            ),
          )
        : null,
      saved?.hasKey
        ? h(
            'div',
            { className: 'testRow' },
            h(
              'button',
              { className: 'btn ghost', type: 'button', disabled: busy, onClick: () => setDialog('api') },
              '删除已保存的密钥',
            ),
          )
        : null,
      h(
        Field,
        {
          label: saved?.hasDeepseekKey ? 'DeepSeek 语音密钥（已保存，不回显）' : 'DeepSeek 语音密钥',
          hint: '仅用于语音合成与识别；留空保留已保存的密钥。',
        },
        h('input', {
          'aria-label': 'DeepSeek 语音密钥',
          type: 'password',
          autoComplete: 'new-password',
          value: deepseekApiKey,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDeepseekApiKey(event.currentTarget.value),
          placeholder: '输入语音密钥（可留空）',
        }),
      ),
      saved?.hasDeepseekKey
        ? h(
            'div',
            { className: 'testRow' },
            h(
              'button',
              { className: 'btn ghost', type: 'button', disabled: busy, onClick: () => setDialog('voice') },
              '删除语音密钥',
            ),
          )
        : null,
      h(
        Field,
        { label: '余额查询服务商', hint: '可选：选择后可查询该服务商余额。' },
        h(
          'select',
          {
            'aria-label': '余额查询服务商',
            value: balanceProvider,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setBalanceProvider(event.currentTarget.value),
          },
          [
            h('option', { value: '' }, '不查询余额'),
            h('option', { value: 'deepseek-official' }, 'DeepSeek 官方'),
            h('option', { value: 'opencode-go' }, 'opencode Go'),
            h('option', { value: 'commandcode' }, 'commandcode'),
          ],
        ),
      ),
      h('div', { className: 'testRow' }, [
        h('button', { className: 'btn', type: 'button', disabled: busy, onClick: testConnection }, '测试连接'),
        h(
          'button',
          { className: 'btn ghost', type: 'button', disabled: busy || !balanceProvider, onClick: queryBalance },
          '查询余额',
        ),
        h(
          'span',
          {
            className: statusClass(test.startsWith('✗') ? 'error' : test ? 'ok' : ''),
            role: 'status',
            'aria-live': 'polite',
          },
          test,
        ),
        h(
          'span',
          {
            className: statusClass(balance.startsWith('✗') ? 'error' : balance ? 'ok' : ''),
            role: 'status',
            'aria-live': 'polite',
          },
          balance,
        ),
      ]),
    ]),
    h(Card, { title: '定时自动碎碎念' }, [
      h(Check, {
        checked: automaticWhispers,
        label: '开启自动碎碎念',
        onChange: setAutomaticWhispers,
        hint: '按桌宠各自设置的间隔调用模型；手动触发不受此开关限制。',
      }),
      h(Check, {
        checked: whispersOnlyOffPeak,
        disabled: !official,
        label: '仅在谷价时执行碎碎念',
        onChange: setWhispersOnlyOffPeak,
        hint: official ? '使用北京时间判断 DeepSeek 谷价时段。' : '仅 DeepSeek 官方 API 支持该时段规则。',
      }),
    ]),
    h(Card, { title: '对话上下文' }, [
      h(Check, { checked: chatEnabled, label: '启用 AI 对话', onChange: setChatEnabled }),
      h('div', { className: 'grid2' }, [
        h(
          Field,
          { label: '对话历史轮数', hint: '每次请求携带最近的历史轮数，0 表示不带历史。' },
          h('input', {
            'aria-label': '对话历史轮数',
            type: 'number',
            min: 0,
            max: 1000,
            value: chatMemoryRounds,
            onChange: (event: ChangeEvent<HTMLInputElement>) => setChatMemoryRounds(Number(event.currentTarget.value)),
          }),
        ),
        h(
          Field,
          { label: '对话配图张数上限', hint: '每次对话最多附带的图片数量，0 表示不限制。' },
          h('input', {
            'aria-label': '对话配图张数上限',
            type: 'number',
            min: 0,
            max: 1000,
            value: chatImageLimit,
            onChange: (event: ChangeEvent<HTMLInputElement>) => setChatImageLimit(Number(event.currentTarget.value)),
          }),
        ),
      ]),
    ]),
    h('div', { className: 'footer' }, [
      h('p', { className: statusClass(kind), role: 'status', 'aria-live': 'polite' }, status),
      h('button', { className: 'btn primary', type: 'submit', disabled: busy || !saved }, '保存设置'),
    ]),
    clearDialog,
  ]);
}

function App(): ReactNode {
  const [tab, setTab] = useState<'chat' | 'config'>('chat');
  const [title, setTitle] = useState('对话');
  const switchTab = (value: 'chat' | 'config') => {
    setTab(value);
    setTitle(value === 'chat' ? '对话' : '配置');
  };
  useEffect(() => {
    const root = document.documentElement;
    const media = matchMedia('(prefers-color-scheme: dark)');
    let selected: 'system' | 'light' | 'dark' = 'system';
    const apply = () => {
      root.dataset.uiTheme = selected === 'dark' || (selected === 'system' && media.matches) ? 'dark' : 'light';
    };
    const refresh = () => {
      void request<{ main?: { uiTheme?: unknown } }>('/config')
        .then((value) => {
          const next = value.main?.uiTheme;
          if (next === 'system' || next === 'light' || next === 'dark') {
            selected = next;
            apply();
          }
        })
        .catch(() => undefined);
    };
    media.addEventListener('change', apply);
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      media.removeEventListener('change', apply);
      window.clearInterval(timer);
    };
  }, []);
  return h('main', { className: 'shell' }, [
    h('aside', { className: 'side' }, [
      h('div', { className: 'brand' }, [
        h('img', { className: 'brandLogo', src: '/standalone-ai/icon.png', alt: '' }),
        h('span', null, '桌宠'),
      ]),
      h(
        'nav',
        { className: 'nav', 'aria-label': '设置分区' },
        h(
          'div',
          { className: 'navList', role: 'tablist' },
          (['chat', 'config'] as const).map((item) =>
            h(
              'button',
              {
                key: item,
                type: 'button',
                className: 'navCell',
                role: 'tab',
                'aria-selected': tab === item,
                onClick: () => switchTab(item),
              },
              item === 'chat' ? '对话' : '配置',
            ),
          ),
        ),
      ),
      h('div', { className: 'sideFoot' }, '独立模式'),
    ]),
    h('div', { className: 'main' }, [
      h('div', { className: 'topbar' }, h('h1', { className: 'pageTitle' }, title)),
      tab === 'chat'
        ? h(
            'section',
            { className: 'panel' },
            h('div', { className: 'pet-chat-host', id: 'pet-chat-root' }, h(PetChatPanel)),
          )
        : h(
            'section',
            { className: 'panel' },
            h('div', { className: 'scroll' }, [h(RecoveryCard), h(PetConfigSection), h(AiSettings)]),
          ),
    ]),
  ]);
}

const root = document.getElementById('settings-root');
if (root) createRoot(root).render(h(App));
