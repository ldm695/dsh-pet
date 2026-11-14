/**
 * 自动碎碎念的调度结论：把「宠物自身开关」与「独立模式 AI 是否就绪」合成是否启用，周期只取宠物配置。
 * 不负责计时与生成；周期唯一来源是宿主侧的 `eventsRefreshSec.whisper`。
 * @module dsh-pet/src/host/whisper-policy
 */

export interface StandaloneWhisperPolicy {
  /** 独立模式服务是否已就绪（配置齐全且未暂停）。 */
  isReady(): boolean;
  /** 独立模式全局自动碎碎念开关与峰谷门控。 */
  allowsAutomaticWhisper?(): boolean;
}

/**
 * 自动碎碎念的调度结论：是否启用 + 实际周期。
 *
 * 独立模式另需 AI 就绪；DSH 宿主模式下只看宠物配置自身的开关与周期。
 */
export function automaticWhisperSchedule(
  policy: StandaloneWhisperPolicy | undefined,
  petEnabled: boolean,
  configuredPeriodSec: number,
): { enabled: boolean; periodSec: number } {
  if (!policy) return { enabled: petEnabled, periodSec: configuredPeriodSec };
  return {
    enabled: petEnabled && policy.isReady() && (policy.allowsAutomaticWhisper?.() ?? true),
    periodSec: configuredPeriodSec,
  };
}

/** 北京时间 DeepSeek 峰谷计划：工作日 09–12、14–18 为峰价；周末全天谷价。 */
export function isDeepSeekOffPeak(at: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  if (!Number.isInteger(hour) || !weekday) return false;
  if (weekday === 'Sat' || weekday === 'Sun') return true;
  const workday = weekday === 'Mon' || weekday === 'Tue' || weekday === 'Wed' || weekday === 'Thu' || weekday === 'Fri';
  const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  return !workday || !peak;
}
