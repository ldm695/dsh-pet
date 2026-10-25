// 余额数据层与展示视图（src/shared 纯逻辑，浏览器 bundle 与桌面 shared-core 共用）：
// 解析 S 的余额叶子（host 的 BalanceResult）→ 客户端视图 → 档位计算 → 气泡行数据。
// 取数不在本模块：余额由 host 定时器刷新并写进 /state（两端共享同一份结果），本模块只做纯解析/展示。
// 不依赖 React/DOM；host/balance/ 的 BalanceResult 与本模块的 RawBalanceResult 同构（HTTP 契约两端
// 各自声明，host 无需 import 本目录——DSH 单文件加载约束）。
//
// **本模块不认识任何服务商**：只认叶子里的 `shape`（展示形态）与数据自带的业务事实
// （各窗口满额度、滚动窗时长、档位基准、峰谷档位）。服务商名字只用于日志与去重键。
// 加一个服务商只要落到 `windows` / `money` / `points` 之一，这里与两端展示层一行都不用改。

/** 余额叶子里的原始响应（与 host/balance/ 的 BalanceResult 同构；两端按此结构校验） */
export interface RawBalanceResult {
  ok: boolean;
  provider?: string;
  /** 展示形态（host 写叶子时带上）：windows = 三窗口用量，money = 账户金额，points = 积分 */
  shape?: 'windows' | 'money' | 'points' | 'custom';
  reason?: string;
  message?: string;
  data?: {
    rolling?: unknown;
    weekly?: unknown;
    monthly?: unknown;
    rollingResetsAt?: unknown;
    weeklyResetsAt?: unknown;
    monthlyResetsAt?: unknown;
    rollingCapUsd?: unknown;
    weeklyCapUsd?: unknown;
    monthlyCapUsd?: unknown;
    rollingLabel?: unknown;
    /** money 余额统一使用钱包数组，单币种和多币种共用同一契约。 */
    wallets?: unknown;
    tier?: unknown;
    /** points：单位、余额与可选档位基准。 */
    unit?: unknown;
    total?: unknown;
    full?: unknown;
    views?: unknown;
    rows?: unknown;
    detailRows?: unknown;
    percent?: unknown;
  };
}

/** 计价档位装饰（气泡上的「峰/谷」）：由服务商算好后随数据带出，展示层原样渲染 */
export type PricingTier = 'peak' | 'idle';

/** 已解析的余额视图（展示 + 档位计算用） */
export interface CustomNode {
  tag: 'div' | 'span' | 'i' | 'b' | 'strong' | 'em' | 'img';
  text?: string;
  src?: string;
  style?: Record<string, string>;
  children?: CustomNode[];
}

export interface BalanceView {
  provider: string;
  shape: 'windows' | 'money' | 'points' | 'custom';
  ok: true;
  /**
   * 三窗口已用百分比（0-100 数字）+ 各自的重置时间。
   * `monthly` 必有（月度窗口是数据的底线）；`rolling` / `weekly` 可缺省 = 该服务商没有这个窗口。
   */
  rolling?: number;
  weekly?: number;
  monthly?: number;
  rollingResetsAt?: string;
  weeklyResetsAt?: string;
  monthlyResetsAt?: string;
  /**
   * 各窗口满额度（USD），由服务商随数据带出（opencode 是业务常量、commandcode 是接口回报）。
   * 用于「最紧迫窗口」的绝对口径；缺省 → 退化为百分比口径。展示层不再写死任何服务商的额度。
   */
  rollingCapUsd?: number;
  weeklyCapUsd?: number;
  monthlyCapUsd?: number;
  /** 滚动窗展示名（服务商自报，如 `5h`）；缺省回落 DEFAULT_ROLLING_LABEL */
  rollingLabel?: string;
  /** money：每个币种一条钱包；无论单币种还是多币种均使用此数组。 */
  wallets?: MoneyWalletView[];
  /** money：计价档位装饰；缺省 = 渲染成不带峰谷的「余额 ¥x.xx」 */
  tier?: PricingTier;
  /** points：积分/点数余额；没有 full 时不参与百分比与档位动画。 */
  points?: PointsView;
  custom?: { views: CustomNode[]; percent?: number };
}

export interface MoneyWalletView {
  currency: string;
  total: string;
  granted?: string;
  toppedUp?: string;
  fullBalance?: string;
}

/** points 形态的余额值；unit 只作显示后缀，不当作货币。 */
export interface PointsView {
  unit: string;
  total: string;
  full?: string;
}

/** 无效（不支持/缺凭证/抓取失败）：显式标记，不静默 */
export interface BalanceUnavailable {
  provider: string;
  ok: false;
  reason: 'unsupported' | 'credential-missing' | 'fetch-error';
  message?: string;
}

export type BalanceState = BalanceView | BalanceUnavailable;

/**
 * 可选数字：缺省 → undefined；出现但非法 → null（调用方据此整拍跳过——不把 NaN/字符串送进展示层）。
 */
function optNum(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const CUSTOM_TAGS = new Set(['div', 'span', 'i', 'b', 'strong', 'em', 'img']);
export const CUSTOM_LIMITS = {
  maxDepth: 6,
  maxNodes: 200,
  maxChildren: 24,
  maxText: 120,
  maxStyleValue: 64,
  maxSrc: 512,
  maxViews: 4,
} as const;
const CUSTOM_STYLE_KEYS = new Set([
  'display', 'flex', 'flexDirection', 'flexWrap', 'alignItems', 'justifyContent', 'gap', 'margin', 'marginTop',
  'marginRight', 'marginBottom', 'marginLeft', 'padding', 'paddingTop', 'paddingRight', 'paddingBottom',
  'paddingLeft', 'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'color', 'fontSize',
  'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textDecoration', 'whiteSpace',
  'verticalAlign', 'fontVariantNumeric', 'background', 'backgroundColor', 'border', 'borderTop', 'borderBottom',
  'borderLeft', 'borderRight', 'borderRadius', 'overflow', 'opacity',
]);
const BANNED_CUSTOM_STYLE = /url\(|expression|javascript:|vbscript:|@import|\\|\/\*/i;

function parseCustomNode(raw: unknown, depth = 0, budget = { nodes: 0 }): CustomNode | null {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    depth >= CUSTOM_LIMITS.maxDepth ||
    ++budget.nodes > CUSTOM_LIMITS.maxNodes
  ) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.tag !== 'string' || !CUSTOM_TAGS.has(value.tag)) return null;
  const node: CustomNode = { tag: value.tag as CustomNode['tag'] };
  if (typeof value.text === 'string' && value.text.length) node.text = value.text.slice(0, CUSTOM_LIMITS.maxText);
  if (node.tag === 'img') {
    if (
      typeof value.src !== 'string' ||
      !/^https?:\/\//i.test(value.src) ||
      value.src.length > CUSTOM_LIMITS.maxSrc
    ) return null;
    node.src = value.src;
  }
  if (value.style && typeof value.style === 'object' && !Array.isArray(value.style)) {
    const style: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value.style as Record<string, unknown>)) {
      if (
        !CUSTOM_STYLE_KEYS.has(key) ||
        typeof entry !== 'string' ||
        entry.length > CUSTOM_LIMITS.maxStyleValue ||
        BANNED_CUSTOM_STYLE.test(entry)
      ) continue;
      if (entry.trim()) style[key] = entry.trim();
    }
    if (Object.keys(style).length) node.style = style;
  }
  if (value.children !== undefined) {
    if (!Array.isArray(value.children) || value.children.length > CUSTOM_LIMITS.maxChildren) return null;
    const children: CustomNode[] = [];
    for (const child of value.children) {
      const parsed = parseCustomNode(child, depth + 1, budget);
      if (!parsed) return null;
      children.push(parsed);
    }
    if (children.length) node.children = children;
  }
  return node;
}

/**
 * host 的余额原始响应（`BalanceResult`，经 `/state` 的 `sections.balance` 叶子送达）→ 客户端视图。
 *
 * 形状非法 / shape 不认识 → **null**（消费端跳过这一拍）——注意这里**不抛**：它跑在 1s 轮询里，
 * 抛异常会把整拍打断（其余叶子也跟着不渲染）。取数失败（HTTP/网络）不在这里发生：取数在 host，
 * 失败会以 `ok:false` 写进 S，由这里正常映射成"不可用"状态。
 */
export function toBalanceState(raw: unknown): BalanceState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as RawBalanceResult;
  const provider = String(r.provider ?? 'unknown');
  if (r.ok !== true) {
    const reason =
      r.reason === 'unsupported' || r.reason === 'credential-missing' || r.reason === 'fetch-error'
        ? r.reason
        : 'fetch-error';
    return { provider, ok: false, reason, message: typeof r.message === 'string' ? r.message : undefined };
  }

  const d = r.data;
  if (!d || typeof d !== 'object') return null;

  if (r.shape === 'windows') {
    const monthly = optNum(d.monthly);
    const rolling = optNum(d.rolling);
    const weekly = optNum(d.weekly);
    const rollingCapUsd = optNum(d.rollingCapUsd);
    const weeklyCapUsd = optNum(d.weeklyCapUsd);
    const monthlyCapUsd = optNum(d.monthlyCapUsd);
    // 月度窗口是这份数据的底线：缺了/非法 = 认不出响应（滚动窗与周窗口、各窗口额度都是可选）
    if (monthly === undefined || monthly === null) return null;
    // 出现但非法（optNum 返回 null）→ 整拍跳过，不把坏数字送进展示层
    if (
      rolling === null ||
      weekly === null ||
      rollingCapUsd === null ||
      weeklyCapUsd === null ||
      monthlyCapUsd === null
    ) {
      return null;
    }
    return {
      provider,
      shape: 'windows',
      ok: true,
      rolling,
      weekly,
      monthly,
      rollingCapUsd,
      weeklyCapUsd,
      monthlyCapUsd,
      rollingLabel: typeof d.rollingLabel === 'string' && d.rollingLabel.length > 0 ? d.rollingLabel : undefined,
      rollingResetsAt: typeof d.rollingResetsAt === 'string' ? d.rollingResetsAt : undefined,
      weeklyResetsAt: typeof d.weeklyResetsAt === 'string' ? d.weeklyResetsAt : undefined,
      monthlyResetsAt: typeof d.monthlyResetsAt === 'string' ? d.monthlyResetsAt : undefined,
    };
  }
  if (r.shape === 'money') {
    const rawWallets = Array.isArray(d.wallets) ? d.wallets : [];
    const wallets: MoneyWalletView[] = [];
    for (const item of rawWallets) {
      if (!item || typeof item !== 'object') continue;
      const w = item as Record<string, unknown>;
      if (typeof w.currency !== 'string' || !w.currency || typeof w.total !== 'string' || !w.total) continue;
      wallets.push({
        currency: w.currency,
        total: w.total,
        granted: typeof w.granted === 'string' ? w.granted : '0.00',
        toppedUp: typeof w.toppedUp === 'string' ? w.toppedUp : '0.00',
        ...(typeof w.fullBalance === 'string' && w.fullBalance ? { fullBalance: w.fullBalance } : {}),
      });
    }
    if (wallets.length === 0) return null;
    return {
      provider,
      shape: 'money',
      ok: true,
      wallets,
      tier: d.tier === 'peak' || d.tier === 'idle' ? d.tier : undefined,
    };
  }
  if (r.shape === 'points') {
    if (typeof d.unit !== 'string' || d.unit.length === 0) return null;
    if (typeof d.total !== 'string' || d.total.length === 0) return null;
    return {
      provider,
      shape: 'points',
      ok: true,
      points: {
        unit: d.unit,
        total: d.total,
        full: typeof d.full === 'string' && d.full.length > 0 ? d.full : undefined,
      },
    };
  }
  if (r.shape === 'custom') {
    const views: CustomNode[] = [];
    if (Array.isArray(d.views) && d.views.length > 0) {
      if (d.views.length > CUSTOM_LIMITS.maxViews) return null;
      for (const rawView of d.views) {
        const view = parseCustomNode(rawView);
        if (!view) return null;
        views.push(view);
      }
    } else {
      const rows = parseCustomNode(d.rows);
      if (!rows) return null;
      views.push(rows);
      if (d.detailRows !== undefined) {
        const detail = parseCustomNode(d.detailRows);
        if (!detail) return null;
        views.push(detail);
      }
    }
    const percent = typeof d.percent === 'number' && Number.isFinite(d.percent)
      ? Math.max(0, Math.min(100, d.percent))
      : undefined;
    return { provider, shape: 'custom', ok: true, custom: { views, percent } };
  }
  return null;
}

export function customViews(state: BalanceState): CustomNode[] | undefined {
  return state.ok && state.shape === 'custom' ? state.custom?.views : undefined;
}

export function customClickable(state: BalanceState): boolean {
  return (customViews(state)?.length ?? 0) > 1;
}

/**
 * 事件档位百分比（已用百分比语义：0 = 未消耗，100 = 耗尽）：
 * - windows：取三窗口最大（风险最高者为准）
 * - money：余额按**数据自带的基准**（`fullBalance`）折算（基准 20 → 余额 20 元 → 0%，10 元 → 50%，
 *   0 元 → 100%）。多币种各自按基准折算后相加；没有基准 → undefined（不播档位动画，不替服务商猜一个）
 */
export function balancePercent(v: BalanceView): number | undefined {
  if (v.shape === 'custom') return v.custom?.percent;
  if (v.shape === 'points') {
    const total = Number(v.points?.total);
    const full = Number(v.points?.full);
    if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) return undefined;
    return Math.max(0, Math.min(100, 100 - (total / full) * 100));
  }
  if (v.shape === 'money') {
    if (v.wallets?.length) {
      let remaining = 0;
      let based = 0;
      for (const wallet of v.wallets) {
        const total = Number(wallet.total);
        const full = Number(wallet.fullBalance);
        if (!Number.isFinite(total) || !Number.isFinite(full) || full <= 0) continue;
        remaining += total / full;
        based++;
      }
      return based === 0 ? undefined : Math.max(0, Math.min(100, 100 - remaining * 100));
    }
    return undefined;
  }
  // windows：三窗口取最大（只有月窗口时就是它自己）
  return Math.max(v.rolling ?? 0, v.weekly ?? 0, v.monthly ?? 0);
}

/**
 * 余额事件档位索引（与 assets/config.jsonc 注释一致）：
 * index = p === 100 ? 5 : Math.floor(p / 20)
 */
export function balanceEventIndex(p: number): number {
  if (p === 100) return 5;
  const i = Math.floor(p / 20);
  return i < 5 ? i : 4;
}

/** 窗口键（三种窗口类别，与服务商无关） */
export type WindowKey = 'rolling' | 'weekly' | 'monthly';

/**
 * 窗口展示名（联想框文案用）：周、月。
 * 滚动窗的时长是**服务商自己的业务事实**（如 5 小时），不走这张表，见 DEFAULT_ROLLING_LABEL。
 */
export const WINDOW_LABELS = {
  weekly: '周',
  monthly: '月',
} as const;

/**
 * 滚动窗展示名的兜底：服务商应随数据带 `rollingLabel`，缺省时才用它。
 * 之所以要有兜底：缺一个标签会让气泡出现空档，而 5h 是当前两个滚动窗口服务商的共同取值。
 */
export const DEFAULT_ROLLING_LABEL = '5h';

/** 一个窗口的额度概况（用于联想框一句话判定） */
export interface WindowUsage {
  label: string;
  percent: number;
  /** 满额度（USD），由服务商随数据带出；算不出时缺省 */
  quotaUsd?: number;
  /** 剩余额度（USD）= 满额度 × (100 − percent) / 100；满额度未知时缺省 */
  remainingUsd?: number;
  resetsAt?: string;
}

/** 窗口展示名：滚动窗取服务商自报值（缺省 5h），周/月走固定表 */
function windowLabel(v: BalanceView, w: WindowKey): string {
  if (w === 'rolling') return v.rollingLabel ?? DEFAULT_ROLLING_LABEL;
  return WINDOW_LABELS[w];
}

/** 各窗口的满额度（USD）：全部来自数据（展示层不写死任何服务商的额度） */
function windowQuotas(v: BalanceView): Record<WindowKey, number | undefined> {
  return { rolling: v.rollingCapUsd, weekly: v.weeklyCapUsd, monthly: v.monthlyCapUsd };
}

/**
 * 取最先告急的一个窗口（所有 windows 形态的服务商共用同一套，无服务商判断）：
 * - 满额度齐全 → 绝对口径：剩余额度（USD）最少者；
 * - 有窗口给不出满额度 → 退化为相对口径：已用百分比最大者
 *   （两窗额度量级不同，缺一个还硬比绝对剩余会反直觉）。
 * 不存在的窗口直接跳过，不补 0。
 *
 * 绝对口径的副作用（刻意保留）：滚动窗额度最小，通常先报它；两端一致，完整读数见 tools/api-tester.html。
 */
export function urgentWindow(v: BalanceView): WindowUsage | undefined {
  if (v.shape !== 'windows') return undefined;
  const quotas = windowQuotas(v);
  const resets: Record<WindowKey, string | undefined> = {
    rolling: v.rollingResetsAt,
    weekly: v.weeklyResetsAt,
    monthly: v.monthlyResetsAt,
  };
  const present = (['rolling', 'weekly', 'monthly'] as WindowKey[]).filter((w) => v[w] !== undefined);
  if (present.length === 0) return undefined;
  const allQuotas = present.every((w) => {
    const quota = quotas[w];
    return quota !== undefined && quota > 0;
  });

  let best: WindowUsage | undefined;
  for (const w of present) {
    const percent = v[w] ?? 0;
    const quota = quotas[w];
    const cand: WindowUsage = {
      label: windowLabel(v, w),
      percent,
      quotaUsd: quota,
      remainingUsd: allQuotas && quota !== undefined ? (quota * (100 - percent)) / 100 : undefined,
      resetsAt: resets[w],
    };
    if (best === undefined) {
      best = cand;
      continue;
    }
    const moreUrgent = allQuotas ? (cand.remainingUsd ?? 0) < (best.remainingUsd ?? 0) : cand.percent > best.percent;
    if (moreUrgent) best = cand;
  }
  return best;
}

/**
 * 重置时间 → 相对文案（保留 1 位小数）：
 * - 距重置 ≥ 4 天 → 「N.x 天」
 * - 距重置 < 4 天 → 「N.x 小时」
 * - 已过重置点 → 「已重置」；未知时间 → 空串
 */
export function resetInText(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const delta = t - Date.now();
  if (delta <= 0) return '已重置';
  const hoursF = delta / 3_600_000;
  if (hoursF >= 96) return (Math.round((hoursF / 24) * 10) / 10).toFixed(1) + ' 天';
  return Math.max(0.1, Math.round(hoursF * 10) / 10).toFixed(1) + ' 小时';
}

// ---------- 富余额气泡展示视图（浏览器与桌面共用同一份内容/文案/数学） ----------

/** 进度条配色档位：<70 正常 / 70–90 预警 / ≥90 危急（阈值只此一份，两端共用，不各写一套） */
export type QuotaTone = 'ok' | 'warn' | 'crit';
export const QUOTA_WARN_PERCENT = 70;
export const QUOTA_CRIT_PERCENT = 90;
export function quotaTone(percent: number): QuotaTone {
  if (percent >= QUOTA_CRIT_PERCENT) return 'crit';
  if (percent >= QUOTA_WARN_PERCENT) return 'warn';
  return 'ok';
}

/** 气泡行数据：role 决定两端的样式类（浏览器 React span；桌面 DOM div）；tier 用于峰谷着色 */
export type BalanceBubbleRow =
  | { role: 'label'; text: string }
  | { role: 'sub'; text: string }
  | { role: 'error'; text: string }
  | { role: 'tier'; tier: PricingTier; text: string }
  | {
      /** 展开态一行 = 一个窗口：窗口名 + 进度条 + 已用百分比 + 重置倒计时 */
      role: 'quota';
      /** 纯文本兜底（不认识本 role 的消费方也能原样显示这一行） */
      text: string;
      label: string;
      /** 进度条长度 = 已用百分比（0-100） */
      percent: number;
      tone: QuotaTone;
      usedText: string;
      resetText: string;
    };

/** 不可用状态的气泡行（显式说明原因，绝不伪造数字）：
 *  - unsupported：服务商未登记查询接口（配置事实，不是故障）→ 报出 provider id，便于自查"当前到底是谁"
 *  - credential-missing：缺凭证 → 次要行放 host 报的凭证名（不含 message 时不留空行）
 *  - fetch-error：抓取失败 → 次要行放底层错误
 * 次要行为空的会被剔除：空 div 在气泡里会白占一行高度。 */
function unavailableRows(state: BalanceUnavailable): BalanceBubbleRow[] {
  const rows: BalanceBubbleRow[] =
    state.reason === 'unsupported'
      ? [
          { role: 'error', text: '当前服务商暂不支持余额查询' },
          { role: 'sub', text: '当前服务商：' + state.provider },
        ]
      : state.reason === 'credential-missing'
        ? state.provider === 'deepseek-official' && state.message?.includes('DEEPSEEK_API_KEY')
          ? [
              { role: 'error', text: '未配置 API Key' },
              { role: 'sub', text: '请在设置页「AI 模型与对话上下文」中配置 DeepSeek API Key' },
            ]
          : [
              // host 的 message 本身已带「缺少凭证 X」前缀：这里只作次要行原样展示。
              { role: 'error', text: '缺少余额查询凭证' },
              { role: 'sub', text: state.message ?? '' },
            ]
        : [
            { role: 'error', text: '余额查询失败' },
            { role: 'sub', text: state.message ?? '' },
          ];
  return rows.filter((r) => r.role !== 'quota' && r.text !== '');
}

/**
 * 把 BalanceState 渲染成气泡行数据（纯函数，不碰 DOM/React）：
 * - windows：两行 —— 「X额度已用 N%」+ 重置倒计时
 * - money：一行 —— 「余额（峰/谷）¥x.xx」（峰红/谷绿由 role:'tier' 表达）；
 *   服务商没给档位装饰时退化成「余额 ¥x.xx」，不替它编一个峰谷
 * - points：一行 —— 「余额 800 积分」，不套货币符号
 * - 无效：显式展示不可用原因（见 unavailableRows），绝不伪造数字
 */
export function balanceBubbleView(state: BalanceState): BalanceBubbleRow[] {
  if (state.ok) {
    if (state.shape === 'windows') {
      // windows：三窗口中先告急的一个
      const w = urgentWindow(state);
      if (w) {
        const reset = resetInText(w.resetsAt);
        const rows: BalanceBubbleRow[] = [
          { role: 'label', text: w.label + '额度已用 ' + Math.round(w.percent) + '%' },
          { role: 'sub', text: reset ? reset + '重置' : '已重置' },
        ];
        return rows;
      }
      return [{ role: 'label', text: '额度数据不可用' }];
    }
    if (state.shape === 'points') {
      const points = state.points;
      return points
        ? [{ role: 'label', text: '余额 ' + points.total + ' ' + points.unit }]
        : [{ role: 'label', text: '积分数据不可用' }];
    }
    if (state.shape === 'custom') return [];
    // money：多个币种按各自金额展示，CNY 优先；0 余额不占位，全部为 0 时仍显示 ¥0.00。
    const wallets = state.wallets ?? [];
    if (wallets.length === 0) return [{ role: 'label', text: '余额数据不可用' }];
    const visible = wallets
      .filter((wallet) => Number(wallet.total) !== 0)
      .sort((a, b) => (a.currency === 'CNY' ? 0 : 1) - (b.currency === 'CNY' ? 0 : 1));
    const displayWallets = visible.length ? visible : [wallets.find((wallet) => wallet.currency === 'CNY') ?? wallets[0]!];
    const amount = displayWallets
      .map((wallet) => `${wallet.currency === 'USD' ? '$' : wallet.currency === 'CNY' ? '¥' : wallet.currency + ' '}${wallet.total}`)
      .join('/');
    // 档位装饰（峰/谷）只有提供该计价规则的服务商才有；没有就不加括号那一段
    if (!state.tier) return [{ role: 'label', text: '余额 ' + amount }];
    return [
      { role: 'label', text: '余额（' },
      { role: 'tier', tier: state.tier, text: state.tier === 'peak' ? '峰' : '谷' },
      { role: 'label', text: '）' + amount },
    ];
  }
  return unavailableRows(state);
}

/**
 * 展开态行数据（点余额气泡后显示）：三个窗口各一行 —— 窗口名 + 进度条 + 已用百分比 + 重置倒计时。
 *
 * 只列**存在**的窗口：`rolling` / `weekly` 缺省 = 该服务商没有这个窗口，不补 0、不画空条。
 * money / points 形态没有"窗口"这个概念，点开也没有别的读数 → 回落到收起态视图，
 * 于是展开前后内容一致，不会出现"点了一下却什么都没变"的空交互。
 */
export function balanceDetailView(state: BalanceState): BalanceBubbleRow[] {
  if (!state.ok) return unavailableRows(state);
  if (state.shape !== 'windows') return balanceBubbleView(state);
  const resets: Record<WindowKey, string | undefined> = {
    rolling: state.rollingResetsAt,
    weekly: state.weeklyResetsAt,
    monthly: state.monthlyResetsAt,
  };
  const rows: BalanceBubbleRow[] = [];
  for (const w of ['rolling', 'weekly', 'monthly'] as WindowKey[]) {
    const percent = state[w];
    if (percent === undefined) continue;
    // 与收起态同一套重置文案（"已重置" / "N.x 小时重置"），两端直接原样渲染
    const reset = resetInText(resets[w]);
    const usedText = Math.round(percent) + '%';
    const resetText = reset === '' ? '已重置' : reset + '重置';
    rows.push({
      role: 'quota',
      text: windowLabel(state, w) + ' ' + usedText + ' ' + resetText,
      label: windowLabel(state, w),
      percent,
      tone: quotaTone(percent),
      usedText,
      resetText,
    });
  }
  return rows.length > 0 ? rows : balanceBubbleView(state);
}

/** 非 ok 状态「弹不弹文字说明气泡」的判定结果 */
export interface BalanceNoticeDecision {
  /** true = 本次应弹气泡（文字说明）；false = 静默（同一原因已提示过，且非显式请求） */
  show: boolean;
  /** 本次提示的原因标识（形如 `unsupported:unregistered-provider`；ok 状态为 null）：调用方存下，供下次比较 */
  key: string | null;
}

/**
 * 余额不可用时是否弹气泡（桌面端统一判定）：
 * - 显式请求（`/balance` 命令、桌面「查看余额」菜单）：一律弹——用户问了就该有答复，包括"不支持"这件事；
 * - 自动轮询：只在原因（含服务商）**变化**时弹一次（首次检测到也算变化），避免每 30 分钟反复刷同一句话。
 * 判定纯粹基于传入的 lastKey，不持有状态；调用方负责保存返回值里的 key。
 */
export function decideBalanceNotice(
  state: BalanceState,
  lastKey: string | null,
  explicit: boolean,
): BalanceNoticeDecision {
  if (state.ok) return { show: false, key: null };
  const key = state.reason + ':' + state.provider;
  return { show: explicit || key !== lastKey, key };
}
