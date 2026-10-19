import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { jsx } from 'react/jsx-runtime';
import { useCallback, useEffect, useRef, useState } from 'react';
import { flattenConfigPets } from '../shared/config';
import { makePetConfigSection, petBridge, zh } from './pet-settings';

type RenderMode = 'hardware' | 'software';

const APP_DISPLAY_NAME =
  (window as Window & { DSH_PET_APP_NAME?: string }).DSH_PET_APP_NAME === 'DSH Pet' ? 'DSH Pet' : '哦鲸鲸';
document.title = `${APP_DISPLAY_NAME} 设置`;

function AutoStartSettings(): ReturnType<typeof jsx> {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/dsh-pet-7340/auto-start', { cache: 'no-store' })
      .then(async (response) => {
        const data = (await response.json()) as { available?: unknown; enabled?: unknown; error?: unknown };
        if (!alive) return;
        setAvailable(data.available === true);
        setReady(true);
        if (!response.ok) {
          setMessage({
            ok: false,
            text: typeof data.error === 'string' ? data.error : `读取开机自启动设置失败：HTTP ${response.status}`,
          });
          return;
        }
        setEnabled(data.enabled === true);
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setAvailable(true);
        setReady(true);
        setMessage({ ok: false, text: '读取开机自启动设置失败：' + (error instanceof Error ? error.message : String(error)) });
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (nextEnabled: boolean): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/dsh-pet-7340/auto-start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const data = (await response.json()) as { available?: unknown; enabled?: unknown; error?: unknown };
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
      setAvailable(data.available === true);
      setEnabled(data.enabled === true);
      setMessage({ ok: true, text: data.enabled === true ? '已启用，Windows 登录时将启动 DSH Pet。' : '已关闭开机自启动。' });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '保存开机自启动设置失败。' });
    } finally {
      setBusy(false);
    }
  };

  if (ready && !available) return null;

  return jsx('div', {
    style: {
      marginTop: '16px',
      paddingTop: '12px',
      borderTop: '1px solid var(--dsw-alias-border-l2)',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    },
    children: [
      jsx('div', {
        className: 'dsh-pet-cfg__field',
        children: [
          jsx('span', { className: 'dsh-pet-cfg__flabel', children: '开机自启动' }),
          jsx('div', {
            className: 'dsh-pet-cfg__toggle',
            children: jsx('label', {
              children: [
                jsx('input', {
                  type: 'checkbox',
                  checked: enabled,
                  disabled: !ready || !available || busy || (message !== null && !message.ok),
                  onChange: (event) => void save(event.currentTarget.checked),
                }),
                jsx('span', { children: '登录 Windows 时启动 DSH Pet' }),
              ],
            }),
          }),
        ],
      }),
      jsx('div', {
        className: 'dsh-pet-cfg__note',
        children: ready
          ? '启用后会随 Windows 登录启动桌宠，并在托盘运行；不会自动打开设置页面。切换后立即生效。'
          : '正在读取开机自启动设置…',
      }),
      message
        ? jsx('div', {
            className: 'dsh-pet-cfg__msg' + (message.ok ? '' : ' is-err'),
            role: message.ok ? 'status' : 'alert',
            children: message.text,
          })
        : null,
    ],
  });
}

function RenderModeSettings(): ReturnType<typeof jsx> {
  const [renderMode, setRenderMode] = useState<RenderMode>('hardware');
  const [savedMode, setSavedMode] = useState<RenderMode>('hardware');
  const [activeMode, setActiveMode] = useState<RenderMode>('hardware');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/dsh-pet-7340/render-mode', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
      .then((data: { renderMode?: unknown; activeMode?: unknown }) => {
        if (!alive) return;
        if (data.renderMode === 'hardware' || data.renderMode === 'software') {
          setRenderMode(data.renderMode);
          setSavedMode(data.renderMode);
        }
        if (data.activeMode === 'hardware' || data.activeMode === 'software') setActiveMode(data.activeMode);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (alive) {
          setReady(true);
          setMessage({
            ok: false,
            text: '读取渲染方式失败：' + (error instanceof Error ? error.message : String(error)),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/dsh-pet-7340/render-mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ renderMode }),
      });
      const data = (await response.json()) as {
        renderMode?: unknown;
        activeMode?: unknown;
        restartRequired?: unknown;
        error?: unknown;
      };
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'HTTP ' + response.status);
      if (data.renderMode === 'hardware' || data.renderMode === 'software') {
        setRenderMode(data.renderMode);
        setSavedMode(data.renderMode);
      }
      if (data.activeMode === 'hardware' || data.activeMode === 'software') setActiveMode(data.activeMode);
      setMessage({
        ok: true,
        text:
          data.restartRequired === true
            ? `已保存。请完全退出并重新启动${APP_DISPLAY_NAME}后生效；关闭设置窗口不会重启应用。`
            : '已保存，当前运行方式已与设置一致。',
      });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : '保存渲染方式失败。' });
    } finally {
      setBusy(false);
    }
  };

  const option = (value: RenderMode, label: string): ReturnType<typeof jsx> =>
    jsx('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': renderMode === value,
      className: 'dsh-pet-cfg__btn' + (renderMode === value ? ' is-primary' : ''),
      disabled: !ready || busy,
      onClick: () => {
        setRenderMode(value);
        setMessage(null);
      },
      children: label,
    });

  return jsx('div', {
    style: {
      marginTop: '16px',
      paddingTop: '12px',
      borderTop: '1px solid var(--dsw-alias-border-l2)',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
    },
    children: [
      jsx('div', {
        className: 'dsh-pet-cfg__field',
        children: [
          jsx('span', { className: 'dsh-pet-cfg__flabel', children: '桌宠渲染方式' }),
          jsx('div', {
            className: 'dsh-pet-cfg__grid2',
            role: 'radiogroup',
            'aria-label': '桌宠渲染方式',
            children: [option('hardware', 'GPU 硬件合成'), option('software', '软件合成')],
          }),
        ],
      }),
      jsx('div', {
        className: 'dsh-pet-cfg__note',
        style: { marginTop: '8px' },
        children: ready
          ? '当前运行：' +
            (activeMode === 'hardware' ? 'GPU 硬件合成' : '软件合成') +
            `。切换后需完全退出并重新启动${APP_DISPLAY_NAME}生效。`
          : '正在读取当前设置…',
      }),
      jsx('div', {
        className: 'dsh-pet-cfg__actions',
        children: [
          jsx('button', {
            type: 'button',
            className: 'dsh-pet-cfg__btn is-primary',
            disabled: !ready || busy || renderMode === savedMode,
            onClick: () => void save(),
            children: busy ? '保存中…' : '保存渲染方式',
          }),
          message
            ? jsx('span', {
                className: 'dsh-pet-cfg__msg' + (message.ok ? '' : ' is-err'),
                role: message.ok ? 'status' : 'alert',
                children: message.text,
              })
            : null,
        ],
      }),
    ],
  });
}

const PetSettings = makePetConfigSection({
  h: jsx,
  useState,
  useEffect,
  useRef,
  useCallback,
  createPortal,
  t: (key) => {
    const standaloneText: Record<string, string> = {
      displayHint: '仅桌面会显示悬浮桌宠；不显示会保留配置但隐藏桌宠。',
      'display.none': '不显示',
      workStatusEnabledHint:
        '启用后跟随工作状态动画；若安装了 DSH 桥接插件或 DSH Pet Codex 状态桥接插件，则同步最近活动的对话，否则保持空闲。',
      notifyToggleHint: '控制 DSH 工作流和桌宠对话回复的通知。保存后生效。',
      modelHint:
        '分别设置碎碎念与对话使用的模型，并设置对话历史轮数。留空表示使用独立版当前 DeepSeek API 模型；也可为每只宠物单独指定模型。',
      modelFollow: '使用独立版默认模型',
      modelFieldHint:
        '使用独立版默认模型：优先读取环境变量 DSH_PET_STANDALONE_DEEPSEEK_MODEL，未设置时使用 deepseek-flash；指定模型调用失败时，会回退到该模型重试一次。',
      invalidModel: '请检查模型设置：服务商与模型要么都选，要么都留空（使用独立版默认模型）。',
      'storage.userData':
        '用户数据：自定义配置 main-config.jsonc、对话记忆 memory.json、自定义动画素材 main-animation/、文件宠物 pet/',
      standaloneStorageNote: `退出桌宠请使用系统托盘菜单中的「退出 ${APP_DISPLAY_NAME}」。删除用户数据会清除配置、对话记忆和自定义素材。`,
    };
    return standaloneText[key] ?? String(zh[key as keyof typeof zh] ?? key);
  },
  notificationIcon: new URL('/dsh-pet-7340/pic/notify-test.png', window.location.href).href,
  notificationAppName: APP_DISPLAY_NAME,
  standaloneAddon: jsx('div', { children: [jsx(AutoStartSettings, {}), jsx(RenderModeSettings, {})] }),
});

async function start(): Promise<void> {
  try {
    const response = await fetch('/dsh-pet-7340/config');
    if (response.ok) {
      const merged = (await response.json()) as Record<string, Record<string, unknown>>;
      petBridge.current = flattenConfigPets(merged);
      petBridge.template = petBridge.current.find((pet) => !pet.extra);
      petBridge.reload = (next) => {
        if (next) {
          petBridge.current = flattenConfigPets(next);
          petBridge.template = petBridge.current.find((pet) => !pet.extra);
        }
      };
    }
  } catch {
    // The form performs its own load and displays its normal retry state.
  }
  const root = document.getElementById('app');
  if (root) createRoot(root).render(jsx(PetSettings, {}));
}

void start();
