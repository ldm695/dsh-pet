/** 宠物睡眠状态：宿主负责选定一套动画，桌面 Helper 负责按顺序播放。 */
export interface SleepSetNames {
  readonly start: string;
  readonly loop: string;
  readonly end: string;
}

export type SleepLeafData = ({ sleeping: true } & SleepSetNames) | { sleeping: false };

/** 从配置文案池随机挑一句；无有效文案时返回 undefined。 */
export function pickSleepText(pool: unknown): string | undefined {
  if (!Array.isArray(pool)) return undefined;
  const texts = pool.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return texts.length ? texts[Math.floor(Math.random() * texts.length)] : undefined;
}

/** 从 animations.sleep 随机选一整套，再从每段候选项中各选一个。 */
export function pickSleepNames(animations: unknown, roll: () => number = Math.random): SleepSetNames | null {
  if (!animations || typeof animations !== 'object' || Array.isArray(animations)) return null;
  const sets = (animations as Record<string, unknown>).sleep;
  if (!Array.isArray(sets)) return null;
  const usable: SleepSetNames[] = [];
  for (const value of sets) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const set = value as Record<string, unknown>;
    const choose = (raw: unknown): string | undefined => {
      if (!Array.isArray(raw)) return undefined;
      const names = raw.filter((name): name is string => typeof name === 'string' && name.length > 0);
      return names.length ? names[Math.floor(roll() * names.length)] : undefined;
    };
    const start = choose(set.start);
    const loop = choose(set.loop);
    const end = choose(set.end);
    if (start && loop && end) usable.push({ start, loop, end });
  }
  return usable.length ? usable[Math.floor(roll() * usable.length)]! : null;
}

/** 进程内睡眠态；插件卸载或 Helper 重启时会清除，避免留下无法唤醒的宠物。 */
export class SleepStore {
  declare private readonly sets: Map<string, SleepSetNames>;
  declare private readonly onChange: (petId: string, data: SleepLeafData) => void;

  constructor(onChange: (petId: string, data: SleepLeafData) => void) {
    this.sets = new Map();
    this.onChange = onChange;
  }

  sleeping(petId: string): boolean {
    return this.sets.has(petId);
  }

  setOf(petId: string): SleepSetNames | null {
    return this.sets.get(petId) ?? null;
  }

  enter(petId: string, set: SleepSetNames): boolean {
    if (this.sets.has(petId)) return false;
    this.sets.set(petId, set);
    this.onChange(petId, { sleeping: true, ...set });
    return true;
  }

  wake(petId: string): boolean {
    if (!this.sets.delete(petId)) return false;
    this.onChange(petId, { sleeping: false });
    return true;
  }

  wakeAll(): void {
    for (const petId of [...this.sets.keys()]) this.wake(petId);
  }
}
