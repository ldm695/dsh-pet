/**
 * DeepSeek 两条路由（官方 API Key / DSH 账号）共用的**业务口径**。
 *
 * 这里的两个东西都是 DeepSeek 自己的事实，不属于展示层：展示层只认「数据带出来的档位与基准」
 * （见 ./types.ts 的 MoneyBalance），所以它们住在 host 侧、由 provider 随数据一起带出。
 */
import type { PricingTier } from './types';

/**
 * 余额档位基准（¥）：余额 ≥ 该值视为 100%（未消耗），据此把余额折算成「已用百分比」驱动档位动画。
 * 余额 20 元 → 0%，10 元 → 50%，0 元 → 100%。
 *
 * 为什么是 ¥20：DeepSeek 充值以 10 元为最小档，20 元是「余量充足」的常用参照；低于它才开始示警。
 */
export const DEEPSEEK_FULL_BALANCE: Readonly<Record<string, string>> = Object.freeze({ CNY: '20', USD: '5' });

export function deepseekFullBalance(currency: string): string | undefined {
  return DEEPSEEK_FULL_BALANCE[currency];
}

/**
 * DeepSeek 峰谷规则里的中国法定节假日（北京时间日期）。
 * 按国务院办公厅年度放假安排人工维护；发布下一年度安排后需在此补录。
 */
const DEEPSEEK_HOLIDAY_VALLEY_DATES = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
  '2026-04-04', '2026-04-05', '2026-04-06', // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
  '2026-06-19', '2026-06-20', '2026-06-21', // 端午
  '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
]);

/**
 * DeepSeek 峰谷计价档位（北京时间）：
 * - 高峰：非节假日工作日 9:00–12:00、14:00–18:00；其余为空闲（低谷）
 * - 周六/周日及中国法定节假日全天按低谷价计费
 * - 法定节假日表按国务院年度安排维护，需在新年度安排公布后补录
 *
 * 在**取数时刻**算好后随数据带出（而不是展示时刻）：气泡只在刷新后显示 ≤10 秒（客户端 1s 轮询
 * 拉取），与显示时刻的偏差只有 1~2 秒。换来的是展示层完全不需要知道任何计价规则。
 */
export function deepseekPricingTier(now: Date = new Date()): PricingTier {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23', // h23 避免午夜被格式化为 "24:00"
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekday = pick('weekday');
  const holidayDate = `${pick('year')}-${pick('month')}-${pick('day')}`;
  const hour = Number(pick('hour'));
  if (DEEPSEEK_HOLIDAY_VALLEY_DATES.has(holidayDate)) return 'idle'; // 法定节假日全天低谷
  if (weekday === 'Sat' || weekday === 'Sun') return 'idle'; // 周末全天低谷
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'idle';
}
