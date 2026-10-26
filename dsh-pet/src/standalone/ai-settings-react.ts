import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { jsx } from 'react/jsx-runtime';
import { SettingsCardHeader, SettingsHelp, SettingsPageHeader, SettingsPageTab, SettingsPageTabs } from './settings-components';
import { AI_SETTINGS_LAYOUT_CSS, SETTINGS_COMPONENT_CSS } from './settings-style';

type Protocol = 'openai-compatible' | 'anthropic' | 'deepseek-official';
interface AiForm {
  protocol: Protocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  clearApiKey: boolean;
  enabled: boolean;
  automaticWhispers: boolean;
  whispersOnlyOffPeak: boolean;
  whisperIntervalSec: number;
  maxTokens: number;
  chatMemoryRounds: number;
  chatImageLimit: number;
  hasKey: boolean;
}
interface TestResult { ok: boolean; message: string; reply?: string; error?: string }

const INITIAL: AiForm = {
  protocol: 'openai-compatible', baseUrl: '', model: '', apiKey: '', clearApiKey: false,
  enabled: false, automaticWhispers: false, whispersOnlyOffPeak: false, whisperIntervalSec: 300, maxTokens: 1024,
  chatMemoryRounds: 5, chatImageLimit: 10, hasKey: false,
};
const PROTOCOLS: Array<{ value: Protocol; label: string }> = [
  { value: 'deepseek-official', label: 'DeepSeek' },
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
];
const CSS_TAG = 'dsh-pet-ai-react-style';

function installStyles(): void {
  if (document.getElementById(CSS_TAG)) return;
  const style = document.createElement('style');
  style.id = CSS_TAG;
  style.textContent = SETTINGS_COMPONENT_CSS + AI_SETTINGS_LAYOUT_CSS + `
.ai-settings__status{margin:0;min-height:20px;color:var(--dsw-alias-label-secondary)}
.ai-settings__status.is-error{color:var(--dsw-alias-state-error-primary)}
.ai-settings__footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
`;
  document.head.appendChild(style);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ProtocolPicker(props: { value: Protocol; disabled: boolean; onChange: (value: Protocol) => void }): ReturnType<typeof jsx> {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = PROTOCOLS.find((option) => option.value === props.value) ?? PROTOCOLS[0];

  useEffect(() => {
    if (!open) return;
    const place = (): void => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(Math.max(bounds.width, 240), window.innerWidth - 16);
      const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8));
      const below = window.innerHeight - bounds.bottom - 12;
      const above = bounds.top - 12;
      const useAbove = below < 100 && above > below;
      setRect({ left, top: useAbove ? Math.max(8, bounds.top - Math.min(160, above) - 4) : bounds.bottom + 4, width, maxHeight: Math.max(80, Math.min(160, useAbove ? above : below)) });
    };
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && !root.current?.contains(target) && !document.querySelector('.ai-settings__protocolPanel')?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
    place();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return jsx('span', {
    ref: root, className: 'dsh-pet-mp',
    children: [
      jsx('button', {
        ref: trigger, type: 'button', className: 'dsh-pet-mp__trigger dsh-pet-cfg__select',
        disabled: props.disabled, 'aria-haspopup': 'listbox', 'aria-expanded': open,
        onClick: () => setOpen((value) => !value),
        children: [jsx('span', { className: 'dsh-pet-mp__label', children: selected.label }), jsx('span', { className: 'dsh-pet-mp__chevron' + (open ? ' is-open' : ''), 'aria-hidden': true, children: '▾' })],
      }),
      open && rect
        ? createPortal(jsx('div', {
            className: 'dsh-pet-mp__panel ai-settings__protocolPanel', role: 'listbox', 'aria-label': '接口协议',
            style: { left: rect.left, top: rect.top, width: rect.width, maxHeight: rect.maxHeight, overflowY: 'auto' },
            children: PROTOCOLS.map((option) => jsx('button', {
              type: 'button', role: 'option', 'aria-selected': option.value === props.value,
              className: 'dsh-pet-mp__item', onClick: () => { props.onChange(option.value); setOpen(false); },
              children: [jsx('span', { className: 'dsh-pet-mp__name', children: option.label }), jsx('span', { className: 'dsh-pet-mp__check', children: option.value === props.value ? '✓' : '' })],
            }, option.value)),
          }), document.body)
        : null,
    ],
  });
}

export function AiSettingsPage(): ReturnType<typeof jsx> {
  const tokenRef = useRef('');
  const clearDialog = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<AiForm>(INITIAL);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('正在读取本机设置…');
  const [messageError, setMessageError] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  useEffect(() => {
    installStyles();
    tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!tokenRef.current) {
      setMessageError(true);
      setMessage('请从桌宠菜单或本机设置页打开此页，以获得本次运行的访问凭据。');
      return;
    }
    let alive = true;
    void request('GET').then((data) => {
      if (!alive) return;
      const next: AiForm = {
        ...INITIAL,
        protocol: data.protocol === 'anthropic' || data.protocol === 'deepseek-official' ? data.protocol : 'openai-compatible',
        baseUrl: typeof data.baseUrl === 'string' ? data.baseUrl : '',
        model: typeof data.model === 'string' ? data.model : '',
        enabled: data.enabled === true,
        automaticWhispers: data.automaticWhispers === true,
        whispersOnlyOffPeak: data.whispersOnlyOffPeak === true,
        whisperIntervalSec: Number(data.whisperIntervalSec) || 300,
        maxTokens: Number(data.maxTokens) || 1024,
        chatMemoryRounds: Number.isFinite(Number(data.chatMemoryRounds)) ? Math.max(0, Number(data.chatMemoryRounds)) : 5,
        chatImageLimit: Number.isFinite(Number(data.chatImageLimit)) ? Math.max(0, Number(data.chatImageLimit)) : 10,
        hasKey: data.hasKey === true,
      };
      setForm(next);
      setReady(true);
      setMessage('');
      setMessageError(false);
    }).catch((error: unknown) => {
      if (!alive) return;
      setMessage(errorMessage(error));
      setMessageError(true);
    });
    return () => { alive = false; };
  }, []);

  async function request(method: 'GET' | 'POST', body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch('/standalone-ai/settings', {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': tokenRef.current, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
      if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
      throw new Error('设置未保存。请检查接口地址、模型名称与密钥，再重试。');
    }
    return (await response.json()) as Record<string, unknown>;
  }

  const update = <K extends keyof AiForm>(key: K, value: AiForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setTest(null);
  };

  const updateProtocol = (protocol: Protocol): void => {
    setForm((current) => ({
      ...current,
      protocol,
      ...(protocol !== 'deepseek-official' ? { whispersOnlyOffPeak: false } : {}),
      ...(protocol === 'deepseek-official' ? { baseUrl: 'https://api.deepseek.com' } : {}),
    }));
    setTest(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const target = event.currentTarget;
    if (!target.reportValidity()) return;
    setBusy(true);
    setMessage('正在保存到本机…');
    setMessageError(false);
    try {
      const result = await request('POST', {
        protocol: form.protocol, baseUrl: form.baseUrl.trim(), model: form.model.trim(), apiKey: form.apiKey,
        clearApiKey: form.clearApiKey, enabled: form.enabled, automaticWhispers: form.automaticWhispers,
        whispersOnlyOffPeak: form.whispersOnlyOffPeak,
        whisperIntervalSec: Number(form.whisperIntervalSec), maxTokens: Number(form.maxTokens),
        chatMemoryRounds: Number(form.chatMemoryRounds), chatImageLimit: Number(form.chatImageLimit),
      });
      const next = { ...form, apiKey: '', clearApiKey: false, hasKey: result.hasKey === true };
      setForm(next);
      setMessage('已保存到本机。');
      setMessageError(false);
    } catch (error) {
      setMessage(errorMessage(error));
      setMessageError(true);
    } finally { setBusy(false); }
  };

  const testConnection = async (): Promise<void> => {
    setBusy(true);
    setTest({ ok: true, message: '正在测试连接，请稍候…' });
    try {
      const response = await fetch('/standalone-ai/test', {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'X-DSH-Pet-Token': tokenRef.current, 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocol: form.protocol, baseUrl: form.baseUrl.trim(), model: form.model.trim(), apiKey: form.apiKey.trim() }),
      });
      const data = (await response.json()) as TestResult;
      setTest({ ...data, ok: response.ok && data.ok === true, message: data.message || data.error || '测试失败' });
    } catch (error) {
      setTest({ ok: false, message: '请求异常：' + errorMessage(error) });
    } finally { setBusy(false); }
  };

  const labelField = (label: string, control: ReturnType<typeof jsx>, note?: string, wide = false): ReturnType<typeof jsx> =>
    jsx('label', {
      className: 'dsh-pet-cfg__field' + (wide ? ' is-wide' : ''),
      children: [jsx('span', { className: 'dsh-pet-cfg__flabel', children: label }), control, note ? jsx('span', { className: 'ai-settings__hint', children: note }) : null],
    });

  const check = (label: string, key: 'enabled' | 'automaticWhispers', wide = false, describedBy?: string): ReturnType<typeof jsx> =>
    jsx('label', {
      className: 'ai-settings__check' + (wide ? ' is-wide' : ''),
      children: [jsx('input', {
        type: 'checkbox', checked: form[key], disabled: busy,
        'aria-describedby': describedBy,
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          if (event.target.checked && form.clearApiKey) setForm((current) => ({ ...current, clearApiKey: false, [key]: true }));
          else update(key, event.target.checked);
        },
      }), label],
    });

  const textInput = (key: 'baseUrl' | 'model' | 'apiKey', props: Record<string, unknown> = {}): ReturnType<typeof jsx> =>
    jsx('input', {
      className: 'dsh-pet-cfg__inp', value: form[key], disabled: busy || (form.clearApiKey && key === 'apiKey'),
      onChange: (event: ChangeEvent<HTMLInputElement>) => update(key, event.target.value), ...props,
    });

  const numberInput = (key: 'whisperIntervalSec' | 'maxTokens' | 'chatMemoryRounds' | 'chatImageLimit', min: number, max: number, hint?: string): ReturnType<typeof jsx> =>
    jsx('input', {
      className: 'dsh-pet-cfg__inp', type: 'number', min, max, step: 1, required: true,
      value: form[key], disabled: busy,
      onChange: (event: ChangeEvent<HTMLInputElement>) => update(key, Number(event.target.value)),
      'aria-describedby': hint,
    });

  return jsx('div', {
    className: 'dsh-pet-cfg ai-settings', 'aria-live': 'polite',
    children: [
      jsx(SettingsPageHeader, {
        title: '桌宠配置',
        help: '独立 AI 服务、定时碎碎念和对话上下文仅用于当前桌宠程序，并保存在本机。',
        actions: [
          jsx('button', {
            key: 'clear-key', className: 'dsh-pet-cfg__btn is-danger', type: 'button', disabled: !ready || busy || !form.hasKey,
            onClick: () => clearDialog.current?.showModal(), children: '清除密钥',
          }),
          jsx('button', {
            key: 'save', className: 'dsh-pet-cfg__btn is-primary', type: 'submit', form: 'settings', disabled: !ready || busy,
            children: busy ? '处理中…' : '保存设置',
          }),
          jsx(SettingsHelp, {
            key: 'save-help', tip: '所有配置与密钥仅保存在当前机器。关闭 AI 后，桌宠仍可正常显示、移动与互动。', end: true,
          }),
        ],
      }),
      jsx(SettingsPageTabs, {
        children: [
          jsx(SettingsPageTab, { key: 'pets', label: '桌宠设置', href: '/settings?tab=pets' }),
          jsx(SettingsPageTab, { key: 'system', label: '全局设置', href: '/settings?tab=system' }),
          jsx(SettingsPageTab, { key: 'ai', label: '独立 AI 设置', active: true }),
        ],
      }),
      jsx('p', { className: 'ai-settings__intro', children: '配置大模型 API 接口，为桌面聊天与碎碎念提供服务。所有设置仅保存在本机。' }),
      jsx('form', {
        id: 'settings', className: 'ai-settings__form', onSubmit: (event: FormEvent<HTMLFormElement>) => void save(event),
        children: [
          jsx('section', {
            className: 'dsh-pet-cfg__card', 'aria-labelledby': 'connection-title',
            children: [
              jsx(SettingsCardHeader, { id: 'connection-title', title: '模型连接' }),
              jsx('div', {
                className: 'ai-settings__fields',
                children: [
                  jsx('div', {
                    className: 'dsh-pet-cfg__field',
                    children: [jsx('span', { className: 'dsh-pet-cfg__flabel', children: '接口协议' }), jsx(ProtocolPicker, { value: form.protocol, disabled: busy, onChange: updateProtocol })],
                  }),
                  labelField('接口地址（Base URL）', textInput('baseUrl', { type: 'url', maxLength: 2048, placeholder: form.protocol === 'deepseek-official' ? 'https://api.deepseek.com' : 'https://example.com/v1', spellCheck: false, readOnly: form.protocol === 'deepseek-official' }), form.protocol === 'deepseek-official' ? 'DeepSeek 使用固定官方地址。有效密钥可通过桌宠右键菜单查询余额。' : '填写服务商提供的基础接口地址（支持 HTTP 与 HTTPS，通常以 /v1 结尾）。不要把密钥放进地址。', true),
                  form.protocol !== 'deepseek-official'
                    ? jsx('p', { className: 'ai-settings__notice is-wide', role: 'status', children: '当前接口协议不支持余额查询。选择“DeepSeek”后，可使用桌宠右键菜单查询余额。' })
                    : null,
                  labelField('模型名称', textInput('model', { type: 'text', maxLength: 200, placeholder: '填写服务商的模型 ID，例如 deepseek-chat', spellCheck: false })),
                  jsx('label', {
                    className: 'dsh-pet-cfg__field',
                    children: [
                      jsx('span', { className: 'ai-settings__keyHeading', children: [jsx('span', { className: 'dsh-pet-cfg__flabel', children: 'API 密钥' }), jsx('span', { className: 'ai-settings__hint', children: form.hasKey ? '已保存 · 不回显' : '尚未设置' })] }),
                      textInput('apiKey', { type: 'password', autoComplete: 'new-password', maxLength: 8192, placeholder: '留空保留已保存的密钥' }),
                      jsx('span', { className: 'ai-settings__hint', children: '密钥只写入本机配置，不会回显。留空不会删除旧密钥。' }),
                    ],
                  }),
                  jsx('div', {
                    className: 'ai-settings__testRow is-wide',
                    children: [
                      jsx('button', { className: 'dsh-pet-cfg__btn', type: 'button', disabled: !ready || busy, onClick: () => void testConnection(), children: '测试连接' }),
                      test ? jsx('span', { className: 'test-result ai-settings__testResult' + (test.ok ? ' test-success' : ' test-error'), role: 'status', children: [test.ok ? '✓ ' : '✗ ', test.message, test.reply ? jsx('span', { className: 'reply-preview', children: '回复: ' + test.reply }) : null] }) : null,
                    ],
                  }),
                ],
              }),
            ],
          }),
          jsx('section', {
            className: 'dsh-pet-cfg__card', 'aria-labelledby': 'whisper-title',
            children: [
              jsx(SettingsCardHeader, { id: 'whisper-title', title: '定时自动碎碎念' }),
              check('开启自动碎碎念', 'automaticWhispers'),
              jsx('p', { className: 'ai-settings__notice', children: '开启后，桌宠会按设定间隔定时调用模型并在桌面上说话冒泡（产生 API 费用）。默认关闭；右键菜单中的手动对话与手动碎碎念不受此开关限制。' }),
              jsx('label', {
                className: 'ai-settings__check',
                children: [
                  jsx('input', {
                    type: 'checkbox', checked: form.whispersOnlyOffPeak,
                    disabled: busy || form.protocol !== 'deepseek-official',
                    onChange: (event: ChangeEvent<HTMLInputElement>) => update('whispersOnlyOffPeak', event.target.checked),
                  }),
                  jsx('span', { children: '仅在谷价时执行碎碎念' }),
                ],
              }),
              jsx('div', {
                className: 'ai-settings__fields',
                children: [
                  labelField('碎碎念间隔（秒）', numberInput('whisperIntervalSec', 60, 86400, 'interval-note')),
                  labelField('单次输出上限（tokens）', numberInput('maxTokens', 128, 4096, 'tokens-note')),
                ],
              }),
              jsx('p', { className: 'ai-settings__hint', children: '间隔至少 60 秒，默认 300 秒。输出上限越小，单次回复越简短。' }),
            ],
          }),
          jsx('section', {
            className: 'dsh-pet-cfg__card', 'aria-labelledby': 'context-title',
            children: [
              jsx(SettingsCardHeader, { id: 'context-title', title: '对话上下文' }),
              check('启用 AI 对话', 'enabled', true),
              jsx('div', { className: 'ai-settings__fields', children: [
                labelField('对话历史条数', numberInput('chatMemoryRounds', 0, 1000), '每次对话携带的最近历史轮数；0 表示不带历史。记忆仍保存在本机。'),
                labelField('对话配图张数上限', numberInput('chatImageLimit', 0, 1000), '模型每次对话可参考的表情包数量；0 表示不限制。仅影响对话选图。'),
              ] }),
            ],
          }),
        ],
      }),
      message
        ? jsx('p', {
            className: 'ai-settings__status' + (messageError ? ' is-error' : ''),
            role: messageError ? 'alert' : 'status',
            children: message,
          })
        : null,
      jsx('dialog', {
        ref: clearDialog, className: 'ai-settings__leaveDialog', 'aria-labelledby': 'clear-title', 'aria-describedby': 'clear-description',
        children: [
          jsx('h2', { id: 'clear-title', className: 'dsh-pet-cfg__cardTitle', children: '清除已保存的密钥？' }),
          jsx('p', { id: 'clear-description', children: '确认后将清除密钥并关闭 AI 对话和自动碎碎念。此操作还需要点击“保存设置”才会写入；页面上的其他未保存设置不会丢失。' }),
          jsx('div', {
            className: 'ai-settings__leaveActions',
            children: [
              jsx('button', { className: 'dsh-pet-cfg__btn', type: 'button', onClick: () => clearDialog.current?.close(), children: '取消' }),
              jsx('button', { className: 'dsh-pet-cfg__btn is-danger', type: 'button', onClick: () => {
                setForm((current) => ({ ...current, clearApiKey: true, apiKey: '', enabled: false, automaticWhispers: false }));
                setTest(null);
                clearDialog.current?.close();
              }, children: '确认清除' }),
            ],
          }),
        ],
      }),
    ],
  });
}
