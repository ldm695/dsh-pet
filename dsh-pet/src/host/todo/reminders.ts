/** 待办提醒调度：每拍最多向一只在线、醒着且未被占用的桌宠推送一条提醒。 */
import type { LockStore } from '../lock';
import type { PollStateStore } from '../state';
import type { TodoStore } from './store';
import { pickReminder, reminderText } from './policy';

const TICK_MS = 60_000;
const BUBBLE_DURATION_MS = 15_000;

interface ReminderPet {
  id: string;
  display?: string;
}

function voiceSurface(display: string): 'web' | 'desktop' | 'both' {
  return display === 'web' || display === 'both' ? display : 'desktop';
}

function pickSpeaker(
  pets: readonly ReminderPet[],
  locked: (id: string) => boolean,
  sleeping: (id: string) => boolean,
): ReminderPet | null {
  let desktopOnly: ReminderPet | null = null;
  for (const pet of pets) {
    if (!pet.id || pet.display === 'none' || locked(pet.id) || sleeping(pet.id)) continue;
    if (pet.display === 'web' || pet.display === 'both') return pet;
    desktopOnly ??= pet;
  }
  return desktopOnly;
}

/** 注册一次性递归定时器；返回的 dispose 由宿主 effect 在退出时调用。 */
export function registerTodoReminders(deps: {
  todos: Pick<TodoStore, 'list' | 'markReminded'>;
  state: Pick<PollStateStore, 'writePet' | 'waiterCount'>;
  lock: Pick<LockStore, 'locked'>;
  isSleeping: (petId: string) => boolean;
  pets: () => readonly ReminderPet[];
  voiceEnabled: () => boolean;
  log: { info(message: string): void; warn(message: string): void };
  now?: () => number;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (deps.state.waiterCount() > 0) {
        const now = deps.now?.() ?? Date.now();
        const due = pickReminder(await deps.todos.list(), now);
        if (due) {
          const speaker = pickSpeaker(
            deps.pets(),
            (id) => deps.lock.locked(id),
            deps.isSleeping,
          );
          if (speaker) {
            const voiceTo = deps.voiceEnabled() ? voiceSurface(String(speaker.display ?? '')) : null;
            deps.state.writePet(speaker.id, 'say', {
              text: reminderText(due.todo, now),
              duration: BUBBLE_DURATION_MS,
              ...(voiceTo ? { voiceTo } : {}),
            });
            await deps.todos.markReminded(due.todo.id, now);
            deps.log.info(`[dsh-pet] 待办提醒 todo=${due.todo.id} pet=${speaker.id}`);
          }
        }
      }
    } catch (error) {
      deps.log.warn(`[dsh-pet] 待办提醒失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), TICK_MS);
      timer?.unref?.();
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
