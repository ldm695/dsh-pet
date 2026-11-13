/**
 * dsh-pet desktop helper —— 事件联动（余额 / 碎碎念 / 广播 / 工作状态）。
 *
 * 展示与 tick 回调挂在 PetSprite.prototype 上，必须在 sprite.js 之后加载（顶层就改写原型）；startLoops 是全部轮询的
 * 唯一入口，boot 成功后调用。不负责动画播放与气泡渲染本身（见 sprite.js）。依赖 constants.js / sprite.js。
 *
 * @module dsh-pet/runtime/electron-helper/events
 */
'use strict';

// ---- 工作状态联动（容器轮询 /state，再由共享分配器交给已启用的宠物）----
// 气泡驻留语义与浏览器一致：thinking/working/result/waiting（"事情还没完"）常驻直到状态切走；
//   success/error（"这事结束了"）10s 自动收起；state=null（空闲/回合被打断）收起气泡回待机。
// 动画循环语义：进行中档位循环播（switchTo once=false），终态档位播一遍回 idle 链；
//   回空闲时把正在循环的那段改成"播完即停"（见下面空闲分支），否则 ended 永不触发、链回不去。
PetSprite.prototype.onWorkTick = function onWorkTick(snapshot, tick, animateWorkStatus = true) {
  if (!this.pet.workStatusEnabled) return; // 未启用工作状态联动 -> 该宠物完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevWorkTick) return;
  const previousState = this.workState;
  const previousAnim = this.anim;
  this.prevWorkTick = tick;
  const state = snapshot && snapshot.state ? snapshot.state : null;
  this.workState = state; // 当前工作状态：互动/事件动画播完恢复档位循环用
  // 当前展示条目所属会话：点气泡跳过去要用它。外部槽（`api`）宿主已写成 null，这里只认非空串。
  this.workSessionId =
    snapshot && typeof snapshot.sessionId === 'string' && snapshot.sessionId ? snapshot.sessionId : null;
  const stateChanged = this.prevWorkState !== state;
  this.prevWorkState = state;
  if (this.sleeping) return;
  // 锁期间消费掉自动状态变化但不播放；解锁时 resumeWorkStatusAnim 会依据最新工作状态恢复。
  if (this.frozen) return;
  logWorkStatusDiagnostic('pet-input', {
    petId: this.pet.id,
    tick,
    state,
    animate: animateWorkStatus,
    sourceName: snapshot?.sourceName ?? null,
    previousState,
    previousAnim,
  });
  if (!state) {
    // 回空闲：把正在循环播的进行中档位动画改成「播完即停」。进行中档位走 switchTo(name, false)
    // （loop=true），正常不触发 ended；这里不切动画，链就拿不到推进信号，
    // 宠物会卡在那段工作动画上。只改当前段：它结束后走 handleEnded → playIdle。
    // 睡觉时前台那段是睡姿循环：改掉它的 loop/onended 会既打断睡姿又把随机链拽回来，跳过。
    if (!this.sleeping && S.poolIncludes(this.animations.events?.workStatus ?? [], this.anim)) {
      const frontEl = this.front === 0 ? this.videoA : this.videoB;
      if (frontEl) {
        frontEl.loop = false;
        frontEl.onended = () => this.handleEnded();
      }
    }
    // 空闲：收起常驻气泡
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.workText = null;
    this.workSessionId = null;
    this.renderBubble();
    return;
  }
  if (!animateWorkStatus) {
    // 工作状态气泡与动画一起只展示在本轮选中的宠物上，避免同一状态重复弹窗。
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = null;
    this.workOn = false;
    this.workText = null;
    this.renderBubble();
    return;
  }
  const pool = this.animations.events?.workStatus;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.workStatus，无法播放工作状态动画');
    return;
  }
  const idx = S.WORK_STATUS_INDEX[state];
  const slot = pool[idx];
  if (slot === undefined) {
    console.error('[dsh-pet] work-status 档位索引越界：state=' + state + ' idx=' + idx);
    return;
  }
  // 气泡文本：任务详情（todo/write 提供）优先，否则从条目级 workStatusTexts[档位] 随机抽一句。
  const textGroup = Array.isArray(this.pet.workStatusTexts) ? this.pet.workStatusTexts[idx] : undefined;
  const configuredText =
    Array.isArray(textGroup) && textGroup.length > 0
      ? textGroup[Math.floor(Math.random() * textGroup.length)]
      : undefined;
  const terminal = state === 'success' || state === 'error';
  const completionText =
    state === 'success'
      ? configuredText && configuredText.includes('{{agent}}')
        ? configuredText.split('{{agent}}').join((snapshot && snapshot.sourceName) || 'Agent')
        : snapshot && snapshot.sourceName
          ? snapshot.sourceName + ' 的任务完成啦，真棒！'
          : configuredText
      : configuredText;
  this.workText =
    state === 'success'
      ? completionText || (snapshot && snapshot.task) || null
      : (snapshot && snapshot.task) || configuredText || null;
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' workStatus pet=' +
      this.pet.id +
      ' state=' +
      state +
      ' -> [' +
      idx +
      '] ' +
      name,
  );
  this.stopMove();
  // 气泡点亮/收起只在状态变化时动作：同状态后续 tick（todo 文案更新、其它会话事件搅动 ts）
  // 不重新点亮**已自动收起的终态气泡**——否则"任务完成"的气泡会被后续 ts 变化反复弹回（Bug 2，
  // 与浏览器 workBubbleOn 同一语义）。
  if (stateChanged) {
    this.workOn = true;
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    this.workTimer = terminal
      ? window.setTimeout(() => {
          this.workOn = false;
          this.renderBubble();
        }, BUBBLE_DURATION_MS)
      : null; // 非终态：常驻，不设自动收起
  }
  this.renderBubble();
  // 睡觉：气泡与 workState 已经更新，动画不换——自动来源不该打断睡姿（睡姿循环归睡觉状态机）。
  if (this.sleeping) return;
  // 循环语义：终态播一遍回 idle；非终态多候选档位播一遍 → ended 轮换到下一候选；
  // 非终态单候选档位无限循环。
  const rotating = !terminal && Array.isArray(slot) && slot.length > 1;
  logWorkStatusDiagnostic('animation-select', {
    petId: this.pet.id,
    state,
    anim: name,
    once: terminal || rotating,
  });
  if (terminal || rotating) this.playOnce(name);
  else {
    // switchTo 统一更新当前动画状态，收到 idle 时可以准确识别并退出工作状态循环。
    this.switchTo(name, false); // 进行中循环播（单动画/单候选档位）
  }
};

// 点工作气泡：发「切到这条会话」的意图，再请主进程把 DSH 主窗口提到前台。
// 提窗口必须走主进程的 dsh://（与右键「打开软件」同一条路）：页面侧的 iframe 唤不动被挡住的窗口。
// 桌面宠物是独立渲染进程、拿不到页面的会话服务，跨进程这一跳只能经宿主中转（契约见 openapi 的 /focus-session）。
PetSprite.prototype.openWorkSession = function openWorkSession() {
  const sessionId = this.workSessionId;
  if (!sessionId) return;
  S.postAction(FOCUS_SESSION_URL, { sessionId }).then((ok) => {
    if (!ok) console.warn('[dsh-pet] 跳会话：宿主未接受 pet=' + this.pet.id);
  });
  if (window.petBridge && typeof window.petBridge.focusDshHost === 'function') {
    window.petBridge.focusDshHost();
  }
};

// 余额事件：自动轮询按 balanceEnabled 门控，手动请求无条件。
// manual = 这次刷新是用户主动要的（右键「查看余额」/ `/balance` 命令）：不受开关限制，一律给答复。
// 自动余额报告由 host 传入全局 targetPetId，只播给轮到的桌宠；本地轮流选择保留给
// 未指定目标的旧状态/多宠物 renderer。每宠物独立窗口时不能在各 renderer 各自轮流，否则会同时命中所有窗口。
// 手动菜单请求传 targetPetId，气泡和可用动画仍只作用于被点击的桌宠。
let lastAutoBalancePetId = null;

function selectBalancePet(targetPetId) {
  if (targetPetId) {
    return sprites.find((sprite) => sprite.pet.id === targetPetId) ?? null;
  }

  const eligible = sprites.filter((sprite) => sprite.pet.balanceEnabled);
  if (eligible.length === 0) return null;
  const previousIndex = eligible.findIndex((sprite) => sprite.pet.id === lastAutoBalancePetId);
  const selected = eligible[(previousIndex + 1) % eligible.length];
  lastAutoBalancePetId = selected.pet.id;
  return selected;
}

PetSprite.prototype.onBalanceTick = function onBalanceTick(state, tick, manual, targetPetId) {
  if (this.sleeping) return;
  if (!this.pet.balanceEnabled && !manual) return; // 自动轮询受开关门控；手动请求仍给答复
  if (targetPetId && this.pet.id !== targetPetId) return; // 手动菜单请求只播在被点击的桌宠上
  if (tick === 0 || tick === this.prevTick) return;
  this.prevTick = tick;
  if (this.frozen && !manual) return; // 锁期间忽略自动余额更新，用户手动查询仍然有效
  this.showBalanceNow(state, manual);
};

// 余额不可用（服务商未登记 / 缺凭证 / 抓取失败）：只弹文字说明气泡，不播档位动画。
// 显隐与定时和成功路径同一套；不 stopMove——本次没有动画要抢前台。
// 门控：自动轮询要求 balanceEnabled，手动请求无条件弹（包括「服务商不支持」这件事）。
// 睡觉一票否决：与档位动画同一口径，手动请求也不打断睡姿。
PetSprite.prototype.showBalanceNotice = function showBalanceNotice(state, manual) {
  if (this.sleeping) return;
  if (!this.pet.balanceEnabled && !manual) return; // 自动轮询受开关门控；手动无条件通过
  if (this.frozen && !manual) return; // 占用锁：自动来源不看；手动照常（用户问了就得有答复）
  if (this.sleeping) return; // 睡着不弹：睡姿优先于余额说明
  if (!state || state.ok) return;
  this.bubbleOn = true;
  this.balanceWrap = true; // 文字说明可能多行：renderBubble 据此套用紧凑变体（字号缩到 0.75、宽度下限更窄）
  this.balanceView = S.balanceBubbleView(state);
  this.balanceState = state; // 留着：不可用状态不可展开，但要防止上一次的余额读数残留在字段里
  this.balanceViewIndex = 0;
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// ---- 碎碎念 / 命令气泡 / 对话回复 / 清空（**四合一**）：不再各自轮询 ----
// 改造前这里是两个循环（startWhisperLoop 按 eventsRefreshSec.whisper 轮询 /whisper、
// startBroadcastLoop 1s 轮询 /broadcast）。现在三者都写进 S 的 pets.<id>.say，由上面的
// /state 统一轮询分发到对应宠物（见 applySayLeaf）——本窗口只装一只宠物，按 id 命中即可。

// 推进说话气泡的收起计划并重排计时器：语音合成期间挂起，播完再留一小段尾巴。
// 计划与常量在 shared/bubble-hold，与浏览器端共用同一份（两端行为不能各自漂移）。
PetSprite.prototype.applyWhisperHold = function applyWhisperHold(event) {
  const next = S.reduceBubbleHold(this.whisperHold, event);
  if (next === this.whisperHold) return; // 同引用 = 无事发生，不白重排计时器
  this.whisperHold = next;
  this.whisperOn = next.on;
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = null;
  if (next.delayMs !== null) {
    this.whisperTimer = window.setTimeout(() => {
      this.whisperTimer = null;
      this.applyWhisperHold({ kind: 'hide' });
    }, next.delayMs);
  }
  this.renderBubble();
};

// 收起说话气泡（POST /bubble/clear 的落点）。只动气泡：正在播的动画、余额气泡、
// 工作状态气泡都不碰——气泡与动作是两把锁、分别释放。与浏览器端 clearWhisperBubble 同一语义。
PetSprite.prototype.clearWhisper = function clearWhisper() {
  this.whisperText = '';
  this.whisperView = null;
  this.whisperImage = '';
  this.whisperUrl = '';
  this.applyWhisperHold({ kind: 'clear' });
};

// 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（与余额同一套定时语义）
// image：host 随机抽定的配图名称（未开配图/池为空则空串）
// duration / anim：POST /broadcast 的两个新参数（issue #122 第 5 条）。两者**互相独立**：
//   - anim === false 时整段跳过动画联动——不查池、不换源，也不 stopMove()
//     （stopMove 属于"开始播这段动画"的一部分，不是弹气泡的副作用）。
//     于是配置里缺 events.whisper 时，只弹气泡这条路照样走得通。
//   - duration === 0 表示"这一条不显示"：**不动当前已在显示的气泡**
//     （要收起它请用 POST /bubble/clear，两件事不重叠）。
PetSprite.prototype.showWhisper = function showWhisper(text, image, url, duration, anim) {
  if (this.sleeping) return;
  let name = null;
  if (anim !== false) {
    const pool = this.animations.events?.whisper;
    if (!pool || pool.length === 0) {
      console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
      return;
    }
    // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
    name = S.pickSlot(S.pick(pool, this.anim), this.anim);
  }
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' whisper pet=' +
      this.pet.id +
      (name === null ? ' （不联动动画）' : ' -> [' + name + ']') +
      ' 「' +
      text +
      '」' +
      (image ? ' [' + image + ']' : ''),
  );
  // 先起动画：它与气泡时长是两个独立参数（duration=0 时动画照播、只是不弹泡）
  // 睡觉：气泡照弹（拒绝台词就是这么来的），动画不换——自动来源不该打断睡姿（睡姿循环归睡觉状态机）。
  if (name !== null && !this.sleeping) {
    this.stopMove();
    this.playOnce(name);
  }
  if (duration === 0) return;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
  this.whisperText = text;
  this.whisperImage = typeof image === 'string' ? image : '';
  this.whisperUrl = typeof url === 'string' ? url : '';
  // 收起时机交给收起计划：这句要念时，随后的语音开始事件会把它挂起（见 applyWhisperHold）。
  this.applyWhisperHold({ durationMs: duration ?? BUBBLE_DURATION_MS, kind: 'show' });
};

// 余额展示（气泡 + 档位动画）：周期轮询与菜单点播共用同一展示路径，视觉/行为严格一致。
// 两条门控分得很清楚：
//  - 弹气泡：手动请求（manual）**无条件**弹——用户问了就得有答复，哪怕这只宠物关了 balanceEnabled、
//    哪怕服务商没有百分比语义（纯余额金额也照样显示）；自动轮询则要求有百分比依据。
//  - 档位动画：只属于启用余额的宠物，且要有百分比依据（关掉开关的宠物不该因为被点一次菜单就突然演一遍）。
PetSprite.prototype.showBalanceNow = function showBalanceNow(state, manual) {
  if (!state || !state.ok) return;
  const p = S.balancePercent(state);
  if (!manual && p === undefined && state.shape !== 'custom') return; // custom 可不提供档位百分比
  this.bubbleOn = true;
  this.balanceWrap = false; // 正常余额气泡用常规尺寸，别继承上一次文字说明的紧凑变体
  this.balanceView = S.balanceBubbleView(state);
  this.balanceState = state; // 展开态按页现算窗口明细与用量行（balanceView 只是收起态那两行）
  this.balanceViewIndex = 0; // 新一轮查询一律从第一页开始（与浏览器一致）
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  // 档位动画：开关关闭的宠物不演；没有百分比语义（纯余额金额）也没有档位可映射
  // 睡觉：气泡已经亮起，动画不换——自动来源不该打断睡姿（睡姿循环归睡觉状态机）。
  if (this.sleeping) return;
  if (!this.pet.balanceEnabled) return;
  if (p === undefined) return;
  const pool = this.animations.events?.balance;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
    return;
  }
  const idx = S.balanceEventIndex(p);
  const slot = pool[idx];
  if (!slot) {
    console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  this.stopMove();
  this.playOnce(name);
};

// 点余额气泡：展开/收起三窗口完整读数（与浏览器 src/client/bubble.ts 同一套语义）。
// 两件事一起做：
//  - 淡出 → 换内容 → 淡入：先在 .is-fading 里把 opacity 降到 0，250ms 后才重绘内容，
//    否则内容会在半透明时被替换 = 看得见的硬切；
//  - 重置 10s 气泡定时器：不重置的话，第 8 秒才点开就只剩 2 秒，"看完整信息"这个目的就落空了。
// 余额气泡的内容与展开状态由 renderBubble 直接更新。
PetSprite.prototype.toggleBalanceDetail = function toggleBalanceDetail() {
  if (!this.balanceClickable()) return;
  const pageCount = this.balanceState ? S.balancePageCount(this.balanceState) : 1;
  this.balanceViewIndex = (this.balanceViewIndex + 1) % pageCount;
  this.bubble.classList.add('is-fading');
  if (this.balanceFadeTimer !== null) window.clearTimeout(this.balanceFadeTimer);
  this.balanceFadeTimer = window.setTimeout(() => {
    this.balanceFadeTimer = null;
    this.bubble.classList.remove('is-fading');
    this.renderBubble(); // 重绘内容与展开排版
  }, BALANCE_FADE_MS);
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// 环境气泡（查询天气）：宿主写完 sections.env 后由 applyEnvLeaf 调到这里。
// 睡着不弹（睡姿优先）；占用锁不挡——用户主动点的一次性查询，与手动余额同口径。
// 计时器用自己的 envTimer：与余额共用 bubbleTimer 会互相提前收起。
PetSprite.prototype.showEnvNow = function showEnvNow(state) {
  if (!state || state.petId !== this.pet.id) return;
  if (this.sleeping) return;
  this.envState = state;
  this.envOn = true;
  this.renderBubble();
  if (this.envTimer !== null) window.clearTimeout(this.envTimer);
  this.envTimer = window.setTimeout(() => {
    this.envTimer = null;
    this.envOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// 轮询组装：容器统一拉取与触发，与浏览器端同一套路径。

// 余额不可用 → 文字说明气泡（周期轮询与手动 /balance 共用这一条路径，判定在 shared）：
// explicit（手动触发）一律弹；自动轮询只在原因（含服务商）变化时弹一次，避免反复刷同一句话。
// petId 给了就只弹给那只（右键菜单点的那只），缺省照旧全员。
function applyBalanceNotice(state, explicit, petId) {
  const notice = S.decideBalanceNotice(state, balanceNoticeKey, explicit);
  balanceNoticeKey = notice.key;
  if (notice.show) {
    for (const s of sprites) {
      if (petId !== undefined && petId !== s.pet.id) continue;
      s.showBalanceNotice(state, explicit);
    }
  }
  // 未登记服务商是配置事实（已由气泡说明），不再刷 console；其余原因照旧显式报错，绝不伪造余额
  if (state.reason !== 'unsupported') {
    console.error('[dsh-pet] 余额查询失败 reason=' + state.reason + (state.message ? ' ' + state.message : ''));
  }
}

// ---------- 统一轮询（GET /state，长轮询）：与浏览器同一份数据来源与渲染入口 ----------
// 每个叶子 = { counter, data }：首拉只记基线（不渲染），之后 counter 变了才渲染。
// 各功能逐个接入，旧的独立轮询循环随迁随删。
let stateBaseline = null;
/** 我手里这份 S 的版本号（undefined = 首拉，不带参数 → 立刻拿全量） */
let stateSince;
/** 独立模式不能挂起请求；本机服务器通过响应的 longPoll: false 明确标识。 */
let stateLongPoll = true;

/** 余额叶子 → 展示（成功播档位动画 + 气泡；不可用按 shared 判定弹文字说明）。
 *  叶子带 petId 时只给那只宠物（右键菜单点的那只），不带则所有开了余额的照常显示。 */
function applyBalanceLeaf(leaf) {
  const hit = S.readBalance(leaf);
  if (!hit) return;
  balance = hit.state;
  window.__dshPetDebug.lastBalanceOk = hit.state && hit.state.ok === true;
  if (hit.state.ok) {
    balanceTick++;
    // 睡着一律不播：档位动画与气泡都不更新，手动请求也不例外（睡姿优先）
    for (const s of sprites) {
      if (s.sleeping) continue;
      if (hit.petId !== undefined && hit.petId !== s.pet.id) continue;
      s.onBalanceTick(hit.state, balanceTick, hit.manual);
    }
  } else {
    // 不可用：manual（用户主动要的）一律弹，周期刷新只在原因变化时弹一次
    applyBalanceNotice(hit.state, hit.manual, hit.petId);
  }
}

/** 环境叶子 → 对应宠物弹环境气泡。`petId` 是叶子写的「谁弹」，本窗口只装一只，按 id 命中。
 *  睡着不弹（不打断睡姿）；占用锁不挡——它是用户点「查询天气」发起的一次性查询。 */
function applyEnvLeaf(leaf) {
  const state = S.readEnv(leaf);
  if (!state) return;
  for (const s of sprites) s.showEnvNow(state);
}

/** 说话叶子 → 对应宠物播说话动画 + 气泡。`kind: 'clear'` = 收起气泡，其余 = 弹一个气泡。 */
function applySayLeaf(petId, leaf) {
  const said = S.readSay(leaf);
  if (!said) return;
  for (const s of sprites) {
    if (s.pet.id !== petId) continue;
    if (said.kind === 'clear') {
      s.clearWhisper();
      continue;
    }
    s.showWhisper(said.text, said.image, said.url, said.duration, said.anim);
    // 两端各判各的：叶子点名 desktop 才念，没点名或点了网页端就只弹气泡。
    // 必须留在按 petId 过滤的循环里：每个窗口都收到全部叶子（全局计数器唤醒所有窗口），
    // 放到循环外会让没装这只宠物的窗口跟着一起念，N 只桌面宠物就是 N 份语音。
    S.playSayVoice(said);
  }
}

PetSprite.prototype.showSleepText = function showSleepText(text) {
  this.whisperOn = true;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: Date.now() });
  this.whisperImage = '';
  this.whisperImageUrl = '';
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleTimer = null;
    this.whisperOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// The desktop main process owns one assignment manager shared by all per-pet windows.
const lastWorkStatusAssignmentRevisions = new Map();
const lastWorkStatusStates = new Map();

function logWorkStatusDiagnostic(event, details) {
  const record = { at: new Date().toISOString(), surface: 'desktop', event, ...details };
  if (typeof window !== 'undefined' && typeof window.petBridge?.workStatusDiagnostic === 'function') {
    window.petBridge.workStatusDiagnostic(record);
  } else {
    console.info('[dsh-pet-workdiag] ' + JSON.stringify(record));
  }
}

function eligibleWorkStatusPetIds() {
  return (config?.pets || [])
    .filter((pet) => S.isDesktopVisible(pet.display) && pet.workStatusEnabled)
    .map((pet) => pet.id);
}

function applyWorkStatusAgents(snapshot, stateCounter) {
  window.petBridge?.reconcileWorkStatus(snapshot.agents, eligibleWorkStatusPetIds(), stateCounter);
}

function applyWorkStatusAssignmentResult(result) {
  if (!result || !Array.isArray(result.agents) || !Array.isArray(result.assignments)) return;
  const agents = result.agents;
  const assignmentByPetId = new Map(result.assignments.map((assignment) => [assignment.petId, assignment]));

  logWorkStatusDiagnostic('snapshot', {
    agents: agents.map((agent) => ({
      key: agent.key,
      state: agent.state,
      sourceName: agent.sourceName,
      revision: agent.revision,
    })),
    owners: result.assignments.map(({ agentKey, petId, assignmentRevision }) => ({
      agentKey,
      petId,
      assignmentRevision,
    })),
    eligiblePetIds: eligibleWorkStatusPetIds(),
  });

  for (const owner of result.released) {
    lastWorkStatusAssignmentRevisions.delete(owner.agentKey);
    lastWorkStatusStates.delete(owner.agentKey);
    const sprite = sprites.find((candidate) => candidate.pet.id === owner.petId);
    // If the same pet gets a new owner in this snapshot, transition directly to that owner's state.
    if (sprite && !assignmentByPetId.has(owner.petId)) {
      sprite.onWorkTick({ state: null, task: null }, `${owner.agentKey}:released:${owner.assignmentRevision}`, true);
    }
    if (sprite) {
      logWorkStatusDiagnostic('release', {
        key: owner.agentKey,
        petId: owner.petId,
        assignmentRevision: owner.assignmentRevision,
        reason: 'agent-absent-or-pet-ineligible',
      });
    }
  }

  for (const assignment of result.assignments) {
    const { agent, agentKey, petId, assignmentRevision } = assignment;
    const sprite = sprites.find((candidate) => candidate.pet.id === petId);
    if (!sprite) continue;
    if (lastWorkStatusAssignmentRevisions.get(agentKey) !== assignmentRevision) {
      logWorkStatusDiagnostic('assign', {
        key: agentKey,
        petId,
        state: agent.state,
        revision: agent.revision,
        assignmentRevision,
      });
      lastWorkStatusAssignmentRevisions.set(agentKey, assignmentRevision);
    }
    logWorkStatusDiagnostic('dispatch', {
      key: agentKey,
      petId,
      state: agent.state,
      sourceName: agent.sourceName,
      revision: agent.revision,
      assignmentRevision,
    });
    const previousAgentState = lastWorkStatusStates.get(agentKey);
    lastWorkStatusStates.set(agentKey, agent.state);
    sprite.onWorkTick(
      {
        state: agent.state,
        task: agent.task ?? null,
        sourceName: agent.sourceName,
      },
      `${agentKey}:${agent.revision}:${assignmentRevision}`,
      true,
    );
    if (previousAgentState && previousAgentState !== agent.state && config.voiceNotifyEnabled &&
        ['success', 'error', 'waiting'].includes(agent.state) && (!document.hasFocus() || document.hidden)) {
      const index = S.WORK_STATUS_INDEX[agent.state];
      const group = Array.isArray(sprite.pet.workStatusTexts) ? sprite.pet.workStatusTexts[index] : undefined;
      if (Array.isArray(group) && group.length > 0) S.speakNotice(group[Math.floor(Math.random() * group.length)]);
    }
  }
}

window.petBridge?.onWorkStatusAssignments(applyWorkStatusAssignmentResult);

/** 工作状态叶子 → 每段工作只由一只宠物显示气泡并播放动画。 */
function applyWorkStatusLeaf(leaf) {
  const snap = S.toWorkStatus(leaf.data);
  if (!snap) return;
  applyWorkStatusAgents(snap, leaf.counter);
  workTick++;
  // 睡着不看不听：自动来源的工作状态整条跳过（动画与气泡都不更新），醒来后的下一次状态变化重新对齐
  for (const s of sprites) if (!s.sleeping) s.onWorkTick(snap, workTick);
}

/** DSH 桥接通知 → 系统通知（总开关与宠物对话回复共用 notificationsEnabled）。 */
function applyNotifyLeaf(leaf) {
  const data = leaf && leaf.data;
  if (
    !data ||
    data.type !== 'standalone' ||
    data.source !== 'dsh' ||
    !config ||
    !config.notificationsEnabled ||
    data.sourceForeground === true ||
    (document.hasFocus() && !document.hidden) ||
    typeof Notification === 'undefined' ||
    Notification.permission !== 'granted' ||
    typeof data.title !== 'string' ||
    typeof data.body !== 'string'
  ) {
    return;
  }
  if (window.petBridge && typeof window.petBridge.showDshNotification === 'function') {
    window.petBridge.showDshNotification(leaf.counter, data);
  } else {
    console.warn('[dsh-pet] DSH 桥接系统通知未发送：主进程通知桥不可用');
  }
}

/** 点播动画叶子 → 对应宠物播该动画（其他插件经 POST /anim 写进 S）。
 *  复用**右键菜单同一个处理函数** onMenuAction，所以镜像修正 / 移动类走真实位移 /
 *  其余播一遍的语义与菜单点一下完全一致，这里不重写一遍。
 *  petId 由路径解析出来（pets.<id>.anim）；本窗口只装一只宠物，按 id 命中即可。 */
function applyAnimLeaf(petId, leaf) {
  const hit = S.readAnim(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id !== petId) continue;
    const explicitFacing = hit.facing !== undefined;
    if (explicitFacing) s.facing = hit.facing;
    if (hit.url !== undefined) s.playUrlOnce(hit.url, hit.playbackId);
    else if (hit.name !== undefined)
      s.onMenuAction({ label: hit.name, anim: hit.name, playbackId: hit.playbackId }, explicitFacing, true);
  }
}

/** Position command leaf → move only the matching pet. */
function applyPositionLeaf(petId, leaf) {
  const hit = S.readPosition(leaf);
  if (!hit) return;
  for (const sprite of sprites) {
    if (sprite.pet.id === petId) sprite.moveToCenter(hit.x, hit.y, hit.mode, hit.duration);
  }
}

/** Throw command leaf → launch only the matching pet through the shared physics path. */
function applyThrowLeaf(petId, leaf) {
  const hit = S.readThrow(leaf);
  if (!hit) return;
  for (const sprite of sprites) {
    if (sprite.pet.id === petId) sprite.throwWith(hit.angle, hit.power);
  }
}

function applyLockLeaf(petId, leaf) {
  const hit = S.readLock(leaf);
  if (!hit) return;
  for (const s of sprites) {
    if (s.pet.id === petId) s.setLock(hit);
  }
}

/** 睡觉叶子 → 对应宠物进睡/醒来。它同样是状态而不是指令：三段名由宿主挑定，sprite 只照播并
 *  自己推进「开始（一次）→ 循环（无限）→ 起来（一次）」——视频播完只有渲染端知道。 */
function applySleepLeaf(petId, leaf) {
  const data = leaf && leaf.data;
  if (!data || typeof data !== 'object') return;
  let state;
  if (data.sleeping === false) {
    state = { sleeping: false };
  } else if (data.sleeping === true) {
    // sleeping: true 却缺任何一段名 = 形状非法：宁可不睡（保持现状），也不播一段不存在的动画
    for (const key of ['start', 'loop', 'end']) {
      if (typeof data[key] !== 'string' || data[key] === '') return;
    }
    state = { sleeping: true, start: data.start, loop: data.loop, end: data.end };
  } else {
    return; // 不认识的取值（老宿主 / 脏数据）：跳过这一拍
  }
  for (const s of sprites) {
    if (s.pet.id === petId) s.setSleep(state);
  }
}

/** 第三方菜单快照叶子 → 灌进各宠物（右键菜单据此拼「更多」）。它是当前状态、不是事件，
 *  注册与覆盖时写一次，所有窗口共用同一份快照。 */
function applyMenuLeaf(leaf) {
  const items = S.readMenuItems(leaf ? leaf.data : null, 'desktop');
  for (const s of sprites) s.menuItems = items;
}

/** 跑一拍 /state。返回 true = "按长轮询命中"（宿主支持长轮询，可以立刻再请求） */
async function pollStateOnce() {
  try {
    const s = await S.fetchState(
      STATE_URL,
      stateLongPoll && stateSince !== undefined ? { since: stateSince, timeoutMs: STATE_WAIT_MS } : undefined,
    );
    if (!s) return false;
    stateLongPoll = s.longPoll !== false;
    stateSince = s.counter;
    if (stateBaseline === null) {
      stateBaseline = S.flattenCounters(s); // 首拉：只记基线，不渲染（避免启动/重载时重放旧气泡）
      // 锁是持续租约而非一次性动作；Helper 单独重启时也要恢复宿主中仍有效的锁。
      for (const [petId, leaves] of Object.entries(s.pets || {})) {
        if (leaves && leaves.lock && S.readLock(leaves.lock)?.locked) applyLockLeaf(petId, leaves.lock);
        if (leaves && leaves.sleep && S.readSleep(leaves.sleep)?.sleeping) applySleepLeaf(petId, leaves.sleep);
      }
      // 第三方菜单项是**当前状态**不是事件：首拉就要装上，否则 helper 重启后要等下次注册才出现
      applyMenuLeaf(s.sections ? s.sections.menu : null);
      // 睡觉同样是状态：helper 重启 / 重载配置后宿主仍记着它在睡，这里必须补一次；
      // 否则渲染端显示醒着，而宿主因「已在睡」不回写叶子，只能等宿主重启才恢复。
      for (const [petId, entry] of Object.entries((s && s.pets) || {})) {
        if (entry && entry.sleep && entry.sleep.data !== null) applySleepLeaf(petId, entry.sleep);
      }
      return true;
    }
    const changes = S.takeChanged(s, stateBaseline);
    // 同拍的睡眠状态先于说话叶子应用：睡觉气泡要在入睡清理之后显示，醒来文案也要在退出状态后显示。
    changes.sort((left, right) => {
      const leftSleep = left.path.startsWith('pets.') && left.path.endsWith('.sleep');
      const rightSleep = right.path.startsWith('pets.') && right.path.endsWith('.sleep');
      const leftSay = left.path.startsWith('pets.') && left.path.endsWith('.say');
      const rightSay = right.path.startsWith('pets.') && right.path.endsWith('.say');
      const leftPet = leftSleep || leftSay ? left.path.slice('pets.'.length, left.path.lastIndexOf('.')) : null;
      const rightPet = rightSleep || rightSay ? right.path.slice('pets.'.length, right.path.lastIndexOf('.')) : null;
      return leftPet !== null && leftPet === rightPet ? Number(rightSleep) - Number(leftSleep) : 0;
    });
    for (const change of changes) {
      if (change.leaf.data === null) continue;
      if (change.path === 'sections.balance') applyBalanceLeaf(change.leaf);
      else if (change.path === 'sections.env') applyEnvLeaf(change.leaf);
      else if (change.path === 'sections.workStatus') applyWorkStatusLeaf(change.leaf);
      else if (change.path === 'sections.notify') applyNotifyLeaf(change.leaf);
      else if (change.path === 'sections.menu') applyMenuLeaf(change.leaf);
      else if (change.path.startsWith('pets.') && change.path.endsWith('.say')) {
        // 宠物 id **允许含点号**：按前缀/后缀切片，绝不 split('.')
        applySayLeaf(change.path.slice('pets.'.length, -'.say'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.anim')) {
        // 点播动画：同样按前缀/后缀切片（counter 每次写入都递增，连点两次也会分发两次）
        applyAnimLeaf(change.path.slice('pets.'.length, -'.anim'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.position')) {
        // 位置指令：同样按前缀/后缀切片，绝不 split('.')
        applyPositionLeaf(change.path.slice('pets.'.length, -'.position'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.throw')) {
        // 抛掷指令：同上
        applyThrowLeaf(change.path.slice('pets.'.length, -'.throw'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.lock')) {
        applyLockLeaf(change.path.slice('pets.'.length, -'.lock'.length), change.leaf);
      } else if (change.path.startsWith('pets.') && change.path.endsWith('.sleep')) {
        // 睡觉：同上切片。它是状态而不是指令（见 applySleepLeaf）
        applySleepLeaf(change.path.slice('pets.'.length, -'.sleep'.length), change.leaf);
      }
    }
    return true;
  } catch {
    /* 轻量轮询失败静默：下一拍再试 */
    return false;
  }
}

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;
  S.subscribeVoiceUtterance((event) => {
    const hold = S.utteranceToHold(event);
    for (const sprite of sprites) {
      if (sprite.whisperView?.[0]?.text === event.text) sprite.applyWhisperHold(hold);
    }
  });

  // 语音状态一变就重绘气泡：转圈 → 喇叭（或退回无角标）要立刻反映出来，
  // 不能等到下一条消息把气泡重画。桌面端没有 react，只能靠订阅手动重绘。
  S.subscribeVoiceState(() => {
    for (const s of sprites) s.renderBubble();
  });

  // 语音每句的开始/结束推进气泡的收起计划：合成慢时气泡挂住，播完再收。
  // 按文本认句：本窗口只装一只宠物，但同一份状态是模块单例，认句才不会算到别人头上。
  S.subscribeVoiceUtterance((event) => {
    // 状态机只认 hold/release，语音给的是 start/end：翻译与网页端共用同一份，别再各写一遍。
    const hold = S.utteranceToHold(event);
    for (const s of sprites) if (s.whisperText === event.text) s.applyWhisperHold(hold);
  });

  // 统一轮询是自调度的长轮询（请求 → 处理 → 立刻再请求）：宿主在版本没变时挂起，空闲时
  // 1 请求/秒，叶子一变立刻收到。本窗口只装一只宠物，所以每个窗口各跑一份；全局计数器意味着
  // 任意写入会唤醒所有窗口（有意为之）。
  const stateLoop = async () => {
    const hit = await pollStateOnce();
    setTimeout(() => void stateLoop(), hit && stateLongPoll ? 0 : 1000);
  };
  void stateLoop();
}
