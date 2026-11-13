// 与 config.jsonc 结构完全同构的类型模型（唯一事实来源 = config.jsonc 的
// animations / animationWeights / pets）。运行时（浏览器 PetCard / 桌面 sprite /
// 设置页）直接使用这套结构，不额外造转换后的类型。
//
// 本目录（src/shared）为 Windows EXE 的 Electron renderer 与桌面 shared-core
// 共用的纯逻辑层：无 React / DOM 依赖，渲染与输入绑定由 Electron renderer 负责。

/** 支持的角落 */
export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** 轴对齐矩形（左上角 + 宽高）。显示器工作区、窗口内容区、可视夹取区共用同一形状。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 桌宠显示位置。 */
export type PetDisplay = 'web' | 'desktop' | 'both' | 'none';

/** 桌面宠物窗口的显示层级（全局设置）。 */
export type PetDisplayPriority =
  | 'always-on-top'
  | 'hide-on-fullscreen'
  | 'hide-on-fullscreen-or-maximized'
  | 'normal';

/** 移动动作：一个动作名 + 可选覆盖参数（未写字段取 moves.default） */
export interface MoveSpec {
  name: string;
  params?: Record<string, number>;
}

/** 移动池 */
export interface MovesConfig {
  default: Record<string, number>;
  actions: MoveSpec[];
}

/** 随机动作分类（带文字、镜像会颠倒，facing=right 时跳过） */
export interface Category {
  id: string;
  weight: number;
  noMirror?: boolean;
  actions: string[];
}

/** 事件档位槽位：单个动画名（固定播放，原行为）或候选数组（触发时档内随机抽 1，尽量不连续重复） */
export type EventSlot = string | string[];

/** 事件动画：事件名 → 档位槽位数组（数组顺序 = 档位顺序；不进随机链，只由代码显式触发） */
export type Events = Record<string, EventSlot[]>;

/** 一套睡觉动作：入睡 → 循环 → 醒来。
 *  三段各是候选数组（进入该段时随机抽一个）；整套由 animations.sleep 的外层数组随机挑选，
 *  三段必须来自同一套，否则会出现「蹲着入睡、趴着醒来」。 */
export interface SleepSet {
  start: string[];
  loop: string[];
  end: string[];
}

/** 动画权重。 */
export interface Weights {
  idle: number;
  turn: number;
  move: number;
}

/** config.jsonc 的 animations 段 */
export interface Animations {
  idle: string[];
  turn: string[];
  drag: string[];
  clicks: string[];
  moves: MovesConfig;
  categories: Category[];
  events: Events;
  /** 睡觉动作套（可选）：没写 = 该条目没有睡觉功能，右键菜单不出现「睡觉」。
   *  写了就「整套随机 → 段内随机」取，结构见 {@link SleepSet}。 */
  sleep?: SleepSet[];
  /** 内置玩法「吃白饭」的动画（可选）：键名即玩法 id，值是**恰好 5 个**动画名，
   *  按位置对应：跑向屏幕底部、追饭时的侧身跑、到位后等开饭、吃到碗饭、吃饭团。
   *  不写 = 该条目没有这个玩法；槽位数与顺序是玩法契约（代码按索引取），名字只是素材文件名。 */
  baifan?: string[];
}

/** 一只宠物（与 jsonc pets[i] 同形，position 嵌套）。
 *  可选段（animations / animationWeights / extra / assetRoot / eventsRefreshSec / physics / font / confineToScreen /
 *  workStatusTexts / whisperModel / chatModel）为渲染期派生或「文件定义宠物」专用：
 *  - animations / animationWeights / eventsRefreshSec / physics / font / confineToScreen / whisperModel / chatModel：所属条目的条目级字段，由配置合并
 *    （host readAllConfig / 客户端 flattenConfigPets）在拍平时吹进每只实例——多实例共享。
 *    其中 physics / font / confineToScreen / whisperImageEnabled / chatImageEnabled / chatImageLimit /
 *    chatMemoryRounds / whisperModel / chatModel / eventsRefreshSec 是**全局默认**：文件宠物条目的合并基座取**用户层**
 *    （main-config.jsonc），即"设置页改一次，所有宠物（含 pet pack）都生效"；种类文件仍可在自己
 *    顶层覆盖（见 host/config.ts 的 GLOBAL_DEFAULT_KEYS）。其余条目级字段（animations /
 *    whisperPrompt / memes / workStatusTexts …）的基座是**内置默认**，与用户层无关；
 *    **例外：whisperPrompt 有实例级覆盖**（`pets[].whisperPrompt`，见字段注释）——它是唯一
 *    允许写在实例上的条目级字段，写了就取代条目的那份；
 *  - extra: true 标记该宠物由 pet/ 目录文件定义：设置页不可编辑、保存时排除，
 *    由拍平逻辑统一打标，**永不出现在持久化配置里**；
 *  - assetRoot: 素材目录名（= 配置文件前缀 `<名>`，即 `pet/<名>-animation/`）；素材 URL
 *    用它而不是 id——多实例共享同一素材目录。main 等常规宠物并入 main 条目（assetRoot=main）。
 */
export interface Pet {
  /** 唯一标识（程序定位用：素材/记忆/端点参数都按它；绝不重叠，冲突即配置错误） */
  id: string;
  /** 显示名（可重复）：悬浮提示、AI 人设（无条件追加「你的名字是 X」）、未来命令行定位的显示层。
   *  与 id 的区别：id 唯一、程序认它；name 给人看、可重复。缺失/留空按该宠物 id 处理并告警 */
  name: string;
  size: number;
  /** 人物占屏宽上限（%，默认 20，不设上限）：按本体占屏换算出画框宽，`size` 仍是画框上限。
   *  100 ≈ 不限制（宽窗口下与按 px 显示一致）；填 150 人物会宽于屏幕，但画框仍被 `size` 夹住。
   *  小于 1 或非数字回落到 20。只作用于浏览器半侧——桌面透明窗始终用 `size`。 */
  sizePercent?: number;
  /** 是否启用余额功能：true = 触发余额动画并显示余额气泡，false = 该宠物完全禁用余额。缺失即配置错误 */
  balanceEnabled: boolean;
  /** 是否启用碎碎念：true = 按 eventsRefreshSec.whisper 周期生成一句话并播碎碎念动画，false = 禁用。
   *  缺失默认 true；碎碎念每次生成都会调用当前对话的模型，本地 LLM 单并发时会顶掉正在跑的任务的 KV cache，
   *  不需要的宠物请显式写 false。display 为 none 的宠物整体跳过：不生成、不调模型。 */
  whisperEnabled: boolean;
  /** 是否启用工作状态联动：true=监听 DSH 会话事件（tool/call 等），按 animations.events.workStatus
   *  数组切档位动画 + 气泡；false=禁用。缺失默认 true（内置默认开启）。监听不调用模型，无 KV cache 风险 */
  workStatusEnabled: boolean;
  /** 宠物固定：true = 随机动画链不再抽「转向(turn) / 移动(move)」两档——宠物不自己翻朝向、
   *  也不自己走开，只播原地待机与随机小动作（这两档权重按 0 算，份额自然并入随机小动作）。
   *  **只影响随机链**：右键菜单点播（含「转向 / 移动」两项）、/anim 接口与命令、事件动画
   *  （余额/碎碎念/工作状态）、点击回应与拖拽一律照常——用户主动触发的不受此限制。
   *  缺失默认 false（保持原行为：会自己走、会自己翻） */
  fixedEnabled: boolean;
  /** 仅允许横向漫游：自动移动与菜单移动保持当前高度，路线角度固定为 0°；拖拽与抛掷仍由用户操作控制。 */
  horizontalOnly?: boolean;
  /** 显示位置（desktop/none，必填）：缺失即配置错误，代码不做兜底 */
  display: PetDisplay;
  position: { corner: Corner; marginX: number; marginY: number };
  /** **实例级人设**（可选，`pets[].whisperPrompt`）：碎碎念与对话共用的系统提示词正文。
   *  写了就**取代**所属条目顶层那一份（替换，不是拼接）；没写/空串 = 回落条目。回落发生在
   *  host 消费端（src/host/persona.ts 的 petPersona），合并器不填生效值——所以这里 undefined
   *  就是"跟随条目"，不是错误。
   *  **无长度上限**（与条目级 whisperPrompt 同一口径：只要求非空字符串）。
   *  只写正文：名字（`你的名字是“X”`）与时间背景由 host 无条件追加，不要在这里重复写。 */
  whisperPrompt?: string;
  animations?: Animations;
  animationWeights?: Weights;
  extra?: boolean;
  assetRoot?: string;
  /** 全局默认：事件刷新周期（秒，事件名 → 间隔；整段替换，缺的键由消费端各自兜底）。
   *  `.whisper` 按所属条目读（种类可覆盖）；`.balance` 的消费端只读 main 条目。 */
  eventsRefreshSec?: Record<string, number>;
  /** 全局默认：拖拽抛掷物理参数（用户在 main-config.jsonc 里写一次即对所有宠物生效，
   *  含 pet pack；种类文件顶层写了则用自己那份。host 合并已填默认，拍平时吹入） */
  physics?: PhysicsParams;
  /** 全局默认：是否锁定在当前屏幕（归属规则同 physics）——抛掷与自主漫游都只在当前所在那块屏内活动 */
  confineToScreen?: boolean;
  /** 条目级：睡觉期间被手动打扰时弹的拒绝台词（非空字符串数组，随机挑一句）。 */
  sleepRefuseTexts?: string[];
  /** 条目级：入睡时弹的台词（播「开始」时随机挑一句）。 */
  sleepStartTexts?: string[];
  /** 条目级：醒来时弹的台词（播「起来」时随机挑一句）。 */
  sleepEndTexts?: string[];
  /** 条目级：工作状态气泡文案（外层索引 = 档位 0..5，内层每档可多句随机抽）。
   *  整字段缺失 = 不弹工作状态文本，只播动画。 */
  workStatusTexts?: string[][];
  /** 全局默认：碎碎念单独指定的服务商 + 模型（host 合并已填默认，拍平时吹入；
   *  provider 与 model 都为空 = 跟随当前对话的模型） */
  whisperModel?: ModelSelection;
  /** 全局默认：对话单独指定的服务商 + 模型（同上，都为空 = 跟随当前对话的模型） */
  chatModel?: ModelSelection;
  /** 全局默认：字体（种类 / 字号 / 是否随宠物大小缩放；host 合并已填默认，拍平时吹入） */
  font?: FontConfig;
  /** 条目级：表情包清单（名称 → 给模型看的描述），合并器吹进每只实例、多实例共享。
   *  顺序即配置书写顺序，也就是 chatImageLimit 截取「前 N 张」的依据。 */
  memes?: Record<string, string>;
  /** 条目级：对话配图开关。true = 对话生成时把表情包清单交给模型按语境选一张；缺省按关处理。 */
  chatImageEnabled?: boolean;
  /** 条目级：对话动作联动开关。true = 对话时把 categories 下的动作清单交给模型，
   *  由模型在语境贴合时挑一个当场表演；缺省按关处理。 */
  chatAnimationEnabled?: boolean;
  /** 条目级：对话配图张数上限（非负整数，0 = 不限制）。只截「交给模型的清单」，不截碎碎念抽图。 */
  chatImageLimit?: number;
}

/** 一处「服务商 + 模型」选择（config.jsonc 的 whisperModel / chatModel 段）。
 *  provider 与 model **要么都为空（= 跟随当前对话的模型）要么都非空**——只填一半是配置错误。 */
export interface ModelSelection {
  /** 服务商路由 id（与 DSH 模型选择器同一命名空间） */
  provider: string;
  /** 该服务商下的模型 id */
  model: string;
}

/** config.jsonc 的 physics 段：拖拽抛掷手感参数（全局，所有宠物共用）。
 *  默认值见 {@link DEFAULT_PHYSICS}，内置配置与代码两侧保持一致。 */
export interface PhysicsParams {
  /** 重力加速度（px/s²）：抛掷下落/反弹的基础重力，越大落得越快；0 = 无重力（合法，永不下落/均匀直线飞行） */
  gravity: number;
  /** 碰壁反弹恢复系数 0~1（1 = 完全弹性，0 = 撞上即停；墙/地共用） */
  restitution: number;
  /** 接触面切向摩擦（/s）：撞墙、落地、撞顶后沿接触面方向的速度衰减率，0 = 四面都像冰面 */
  groundFriction: number;
  /** 顶部是否反弹：true = 碰顶反弹；false = 顶部无边界，抛掷可飞出屏幕顶部（重力仍会拉回落） */
  ceilingBounce: boolean;
  /** 总力度（拖拽/抛掷输出增益）：弹簧跟手 K/C、甩抛初速与软上限整体 ×p（1.0 = 现状；必须 > 0） */
  throwPower: number;
  /** 多宠物互相碰撞开关：true（默认）= 飞行中的宠物撞到其它宠物时按动量守恒弹开；false = 互相穿过 */
  petCollision: boolean;
  /** 倾斜控制重力：true（默认）= 手机倾斜方向代替固定向下的重力方向（大小仍由 gravity 决定，竖直时取满值；
   *  gravity 为 0 时倾斜没有可用的量，等同关闭）；false = 重力恒竖直向下。
   *  仅浏览器半侧生效，且传感器只在安全上下文（HTTPS / localhost）可用；缺键按 true。 */
  tiltGravity?: boolean;
  /** 摇一摇抛出：true（默认）= 摇一摇沿甩动方向把宠物甩出去（力度 = 基准 × throwPower），与重力大小无关，
   *  所以 gravity 为 0 时也能用；false = 不读加速度计。同样只在安全上下文可用。缺键按 true。 */
  shakeThrow?: boolean;
  /** 碰撞触觉反馈：true（默认）时撞墙 / 落地 / 撞顶与宠物互撞各震一下。
   *  仅浏览器半侧生效，且要求环境有 Vibration API——iOS 与桌面端没有，静默跳过。
   *  缺省按 true；旧配置里没有这个键也算开。 */
  hapticEnabled?: boolean;
}

/** 字体种类预设 id（config.jsonc 的 font.family 白名单；清单与对应字体栈见 src/shared/fonts.ts） */
export type FontFamilyId = 'candy' | 'yahei' | 'youyuan' | 'kaiti' | 'simsun' | 'comic' | 'system';
/** 设置界面与桌宠右键菜单的主题模式。 */
export type UiTheme = 'system' | 'light' | 'dark';

/** config.jsonc 的 font 段：字体（全局一份，所有宠物共用）。
 *  默认值 = src/shared/fonts.ts 的 DEFAULT_FONT（candy / 21 / true），内置配置与代码两侧保持一致。
 *  **整段替换**（与 physics 同）：写了就整段用自己的，缺的子键不会从内置默认补回来——
 *  所以手改配置时必须三个子键写全，否则整段非法 → 告警 + 取默认。 */
export interface FontConfig {
  /** 字体种类（预设 id）：影响气泡 / 悬浮提示 / 对话窗 / 得分弹窗——即现在用软糖体的全部地方 */
  family: FontFamilyId;
  /** 字号 px：**只**影响气泡与悬浮提示（对话窗与得分弹窗的字号不变）；基准 = 气泡正文字号，
   *  提示与气泡内小字按既有比例派生 */
  size: number;
  /** 字号是否随宠物大小等比缩放：true = 按「实际 size / 基准尺寸」缩放（默认，与接入本配置前一致）；
   *  false = 恒为 size px，宠物放大时字不变 */
  followPet: boolean;
}

/** config.jsonc 全集——运行时直接使用（ANIM 即本类型） */
export interface ClientConfig {
  /** 设置界面与桌宠右键菜单主题；system 跟随操作系统外观。 */
  uiTheme: UiTheme;
  /** DSH 通知总开关：控制 DSH 工作流事件与桌宠对话回复的系统通知；缺失即配置错误 */
  notificationsEnabled: boolean;
  /** 前台聚焦时也提醒：true = 页面可见且持有焦点时照常弹通知、照常播报工作状态语音；
   *  false（默认）= 只在走开或被遮住时提醒。缺这个键按 false 处理，旧配置行为不变。 */
  notifyWhenFocused: boolean;
  /** 点击音效开关：true = 点击宠物时播放内置 click-duck.wav（音量 0.5、100ms 内去重），false = 静音。
   *  内置默认 false（默认静音，不突袭既有用户）。只读 main 条目这一份，pet pack 不单独覆盖。 */
  clickSoundEnabled: boolean;
  /** 桌面模式系统托盘开关：true = 桌面端启动后在通知区域（macOS 为菜单栏）建托盘，列出配置里全部宠物
   *  （含 display 为 web/none 的），勾选即可切回桌面；false = 不建。
   *  缺失默认 true。关掉后「把不在桌面的宠物叫回桌面」在桌面侧没有入口，只能走设置页或网页端右键菜单。 */
  trayEnabled: boolean;
  /** 碎碎念配图开关：true = 每次从表情包池随机抽 1 张连同文本显示（碎碎念无上下文，故随机） */
  whisperImageEnabled: boolean;
  /** 对话配图开关：true=对话时把表情包清单交模型按语境选 1 张（可不选）；false=纯文本 */
  chatImageEnabled: boolean;
  /** 对话动作联动开关：true = 把 categories 下的动作清单交模型按语境挑一个当场表演，false = 纯文字 */
  chatAnimationEnabled: boolean;
  /** 是否锁定在当前屏幕：true = 宠物只在当前所在那块屏内活动——甩出去只在该屏内弹（屏缝当墙），
   *  自主漫游也只在屏内走；false = 跨屏飞行与跨屏行走。根字段，不属于 physics——它不改手感，只改「被允许去哪」。
   *  条目级，必填，缺失即配置错误。 */
  confineToScreen: boolean;
  /** 桌面宠物显示层级：始终置顶 / 全屏时隐藏 / 全屏或最大化时隐藏 / 普通窗口层级。 */
  petDisplayPriority: PetDisplayPriority;
  pets: Pet[];
  animations: Animations;
  animationWeights: Weights;
  /** 拖拽抛掷物理参数（全局，所有宠物共用；host 合并已填默认） */
  physics: PhysicsParams;
  /** 碎碎念用的服务商 + 模型（条目级，host 合并已填默认；两者都为空 = 跟随当前对话的模型） */
  whisperModel: ModelSelection;
  /** 对话用的服务商 + 模型（条目级，host 合并已填默认；两者都为空 = 跟随当前对话的模型） */
  chatModel: ModelSelection;
  /** 事件刷新周期（秒）：事件名 → 间隔；balance = 余额数据刷新 + 动画触发间隔 */
  eventsRefreshSec: Record<string, number>;
}
