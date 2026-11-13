// 系统通知：事件帧 → toast 文案映射（src/shared 单一来源）。
// 这是**独立于宠物**的能力（监测 DSH 事件 → 弹系统 toast），天然只随 DSH 网页端走：
//   - 浏览器半侧 notify.ts 轮询 host 的 /dsh-pet-7340/notify 增量帧队列，消费本映射；
//   - 帧由 host 侧监听 DSH 宿主事件生成（turn/end、approval/asked、tool/call-ask_user_question、
//     agent/error，见 host/notify-events.ts）——DSH 0.1.5 删除了浏览器侧 api.events.mux/host
//     事件流，旧实现就是经该流（session/event、approval/requested、question/requested 与
//     host/agent-error）消费本映射，帧契约不变，只是帧的产地从浏览器直连改为 host 转发；
//   - 桌面模式是宠物本体，不重复实现通知（宠物 ≠ 通知；「两端一致」只约束宠物行为）。
// 纯函数无副作用；帧形状不匹配/不认识的类型一律返回 null（不弹、不报错）。

/** 通知图标文件名（不含扩展名；浏览器半侧拼完整 URL：/dsh-pet-7340/pic/<name>.png） */
export const NOTIFY_ICONS = {
  done: 'notify-done',
  error: 'notify-error',
  truncated: 'notify-truncated',
  approval: 'notify-approval',
  question: 'notify-question',
  test: 'notify-test',
} as const;

export const MAX_BODY = 80;

/** 会话名在标题里的截断上限（字符）：名字只是认人用，太长会把事件类型挤出标题那一行。 */
const MAX_SESSION_NAME = 30;

/** 文案截断（与弹窗一致：超长只留前 80 字符）。 */
export function truncate(text: string): string {
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) + '…' : text;
}

/** 会话名 → 能放进标题的名字：去掉首尾空白并截断；没有名字时返回 undefined。 */
function sessionNameOf(sessionTitle: string | undefined): string | undefined {
  const name = sessionTitle?.trim();
  if (!name) return undefined;
  return name.length > MAX_SESSION_NAME ? name.slice(0, MAX_SESSION_NAME) + '…' : name;
}

/** 「会话名 · 事件」形式的标题；没有会话名时只留事件类型。 */
function composeTitle(sessionTitle: string | undefined, label: string): string {
  const name = sessionNameOf(sessionTitle);
  return name ? name + ' · ' + label : label;
}

/** 通知帧：宿主半侧转发过来的一条 DSH 事件。 */
export interface NotifyFrame {
  type: string;
  [key: string]: unknown;
}

/** session/event 帧里的 turn/end 事件形状 */
interface TurnEndEvent {
  type?: string;
  data?: {
    reason?: { kind?: string; error?: { message?: string } };
    /** 宿主带过来的最后一条回复开头；没有就回落空正文。 */
    text?: string;
  };
}

/**
 * 帧 → toast 文案；不认识的类型或 turn/end 的非弹分支（aborted 等）返回 null。
 *
 * @param frame - 宿主半侧转发的通知帧。
 * @param sessionTitle - 这条帧所属会话的显示名；有它时标题带上会话名，用户同时开着多个会话也能认出是哪一条。
 *   取不到就传 undefined，标题回落固定文案，不影响弹窗。
 */
export function frameToToast(
  frame: NotifyFrame,
  sessionTitle?: string,
): { title: string; body: string; icon: string } | null {
  switch (frame.type) {
    case 'session/event': {
      const ev = (frame.event ?? {}) as TurnEndEvent;
      if (ev.type !== 'turn/end') return null;
      const kind = ev.data?.reason?.kind;
      if (kind === 'completed') {
        const text = typeof ev.data?.text === 'string' ? ev.data.text.trim() : '';
        // 完成通知的标题就是会话名本身：正文已经在讲「这条回复讲了什么」，
        // 再缀一个「对话完成」只是占位，多会话时反而挤掉了认人的信息。
        return {
          title: sessionNameOf(sessionTitle) ?? '对话完成',
          body: text ? truncate(text) : '',
          icon: NOTIFY_ICONS.done,
        };
      }
      if (kind === 'error')
        return {
          title: composeTitle(sessionTitle, '生成失败'),
          body: ev.data?.reason?.error?.message ?? '',
          icon: NOTIFY_ICONS.error,
        };
      if (kind === 'max-tokens')
        return {
          title: composeTitle(sessionTitle, '输出被截断'),
          body: '已达到输出 token 上限',
          icon: NOTIFY_ICONS.truncated,
        };
      // aborted（用户/父代理取消）、interrupted（崩溃恢复）等：不弹
      return null;
    }
    case 'approval/requested': {
      const toolName = typeof frame.toolName === 'string' ? frame.toolName : '';
      const reason = typeof frame.reason === 'string' && frame.reason ? frame.reason : '';
      return {
        title: composeTitle(sessionTitle, '正在申请权限'),
        body: (toolName ? '工具「' + toolName + '」' : '') + (reason ? '：' + reason : ''),
        icon: NOTIFY_ICONS.approval,
      };
    }
    case 'question/requested': {
      const q =
        (Array.isArray(frame.questions) && (frame.questions as Array<{ question?: string }>)[0]?.question) || '';
      return { title: composeTitle(sessionTitle, '模型在等你回答'), body: q, icon: NOTIFY_ICONS.question };
    }
    case 'host/agent-error': {
      return {
        title: '生成失败',
        body: typeof frame.message === 'string' ? (frame.message as string) : '',
        icon: NOTIFY_ICONS.error,
      };
    }
    default:
      return null;
  }
}
