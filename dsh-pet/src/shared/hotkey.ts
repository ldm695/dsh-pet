/** 悬停快捷键共用判据：输入字段中不抢按键，也不拦截带修饰键的组合键。 */
export interface HotkeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

export function isBareKey(e: HotkeyEvent, key: string): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && String(e.key).toLowerCase() === key && !isTypingTarget(e.target);
}
