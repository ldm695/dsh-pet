/**
 * 设置页启动：分区切换、初次加载与保存按钮接线。
 *
 * 配置页把桌宠与 AI 两块放在同一个面板里，各自加载各自的接口：桌宠读 /config，
 * AI 读 /standalone-ai/settings，两套保存互不影响。
 * 缺令牌时只提示、不发任何请求——本页所有写操作都依赖那次运行有效的凭证。
 * @module dsh-pet/src/standalone/settings-page/script/boot
 */

/** 生成启动片段。 */
export function bootScript(): string {
  return `
let protocolSelect = null;
let balanceSelect = null;

function mountProtocolSelect() {
  const host = byId('protocol-host');
  if (!host) return;
  protocolSelect = createSelect(
    [
      { value: 'openai-compatible', label: 'OpenAI 兼容' },
      { value: 'anthropic', label: 'Anthropic' },
      { value: 'deepseek-official', label: 'DeepSeek' },
    ],
    'openai-compatible',
    () => {
      forgetModelOptions();
      syncProtocolFields();
    },
  );
  protocolSelect.root.firstElementChild.setAttribute('aria-labelledby', 'protocol-label');
  host.append(protocolSelect.root);
}

function syncProtocolFields() {
  const deepseek = !!protocolSelect && protocolSelect.getValue() === 'deepseek-official';
  const address = byId('baseUrl');
  const note = byId('endpoint-note');
  const label = byId('balance-provider-label');
  const balanceField = typeof label?.closest === 'function' ? label.closest('.field') : null;
  if (deepseek && address && !address.value) address.value = 'https://api.deepseek.com';
  if (address) {
    address.readOnly = deepseek;
    address.placeholder = deepseek ? 'https://api.deepseek.com' : 'https://example.com/v1';
  }
  if (note) note.textContent = deepseek
    ? 'DeepSeek 使用固定官方地址；保存官方密钥后可查询余额。'
    : '服务商提供的基础接口地址，支持 HTTP 与 HTTPS，通常以 /v1 结尾。不要把密钥放进地址。';
  if (balanceField) balanceField.hidden = !deepseek;
  const offPeak = byId('whispersOnlyOffPeak');
  if (offPeak) offPeak.disabled = !deepseek;
}

function mountBalanceSelect() {
  const host = byId('balance-provider-host');
  if (!host) return;
  balanceSelect = createSelect(
    [
      { value: '', label: '不查询余额' },
      { value: 'deepseek-official', label: 'DeepSeek 官方' },
      { value: 'opencode-go', label: 'opencode Go' },
      { value: 'commandcode', label: 'commandcode' },
    ],
    '',
    (picked) => {
      const button = byId('balance-btn');
      if (button) button.disabled = picked === '';
      const result = byId('balance-result');
      if (result) {
        result.textContent = '';
        result.dataset.ok = '';
        result.dataset.error = '';
      }
    },
  );
  balanceSelect.root.firstElementChild.setAttribute('aria-labelledby', 'balance-provider-label');
  host.append(balanceSelect.root);
}

function selectTab(name) {
  for (const cell of document.querySelectorAll('[data-tab]')) {
    const active = cell.dataset.tab === name;
    cell.setAttribute('aria-selected', active ? 'true' : 'false');
    const panel = byId('panel-' + cell.dataset.tab);
    if (panel) panel.hidden = !active;
    if (active && cell.dataset.title) {
      const title = byId('page-title');
      if (title) title.textContent = cell.dataset.title;
    }
  }
}

function wireTabs() {
  const cells = Array.prototype.slice.call(document.querySelectorAll('.navCell'));
  cells.forEach((cell, index) => {
    cell.addEventListener('click', () => selectTab(cell.dataset.tab));
    cell.addEventListener('keydown', (event) => {
      const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
      const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
      if (!forward && !backward) return;
      event.preventDefault();
      const step = forward ? 1 : -1;
      const next = cells[(index + step + cells.length) % cells.length];
      next.focus();
      selectTab(next.dataset.tab);
    });
  });
}

async function loadVoiceCatalog() {
  // 音色与识别实现都是宿主目录：注册了哪些实现，页面就列哪些。
  // 拉不到就回落构建期注入的内置清单，至少内置实现还能选。
  try {
    const body = await callApi('GET', '/voice/voices');
    if (body && Array.isArray(body.providers)) {
      state.voiceOptions = body.providers.flatMap((group) =>
        (group.voices || []).map((voice) => ({
          id: voice.id,
          name: voice.name,
          tag: voice.tag || '',
          provider: group.name,
        })),
      );
    }
  } catch {
    /* 回落内置清单 */
  }
  try {
    const body = await callApi('GET', '/voice/hear-providers');
    if (body && Array.isArray(body.providers)) state.speechProviders = body.providers;
  } catch {
    /* 回落空列表：下拉只显示当前值 */
  }
}

async function loadPets() {
  const status = byId('pet-status');
  setStatus(status, '正在读取本机配置…');
  try {
    const config = await callApi('GET', '/config');
    const meta = await callApi('GET', '/config/meta').catch(() => null);
    if (!config || config.ok === false || !config.main) throw new Error('读取配置失败：宿主没有返回可用的配置。');
    state.meta = meta;
    initDrafts(config);
    renderPetsPanel();
    byId('pet-save').disabled = false;
    setStatus(status, '');
  } catch (error) {
    setStatus(status, (error && error.message) || String(error), 'error');
  }
}

async function loadAi() {
  const status = byId('status');
  try {
    populateAi(await aiRequest('GET'));
    byId('save').disabled = false;
    setStatus(status, '设置只在本机保存。');
  } catch (error) {
    setStatus(status, (error && error.message) || String(error), 'error');
  }
}

async function loadMigrationRecovery() {
  try {
    const recovery = await callApi('GET', '/migration-recovery');
    const panel = byId('migration-recovery');
    if (!panel || !recovery || recovery.available !== true) return;
    panel.hidden = false;
    byId('migration-recovery-summary').textContent =
      '迁移过程发生异常，原桌宠配置已完整备份。可以打开备份文件夹检查，或确认后还原原配置并退出程序。';
    byId('migration-recovery-path').textContent =
      '备份包含 ' + recovery.fileCount + ' 个文件，共 ' + Number(recovery.totalBytes || 0).toLocaleString() + ' 字节：' + recovery.backupDirectory;
    byId('migration-recovery-open').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setStatus(byId('migration-recovery-status'), '正在打开原配置文件夹…');
      try {
        await callApi('POST', '/migration-recovery/open', {});
        setStatus(byId('migration-recovery-status'), '已打开原配置文件夹。', 'ok');
      } catch (error) {
        setStatus(byId('migration-recovery-status'), (error && error.message) || String(error), 'error');
      } finally {
        button.disabled = false;
      }
    }, { once: true });
    byId('migration-recovery-restore').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const confirmed = window.confirm(
        '还原原配置会移除当前桌宠配置、恢复迁移前备份，并立即退出桌宠进程。备份目录：\\n' +
          recovery.backupDirectory +
          '\\n\\n确定继续吗？',
      );
      if (!confirmed) return;
      button.disabled = true;
      setStatus(byId('migration-recovery-status'), '正在还原原配置并退出…');
      try {
        await callApi('POST', '/migration-recovery/restore', {});
      } catch (error) {
        button.disabled = false;
        setStatus(byId('migration-recovery-status'), (error && error.message) || String(error), 'error');
      }
    }, { once: true });
  } catch {
    // 无备份时不显示恢复入口。
  }
}

function boot() {
  wireTabs();
  selectTab('chat');
  // 刷新后地址栏里的令牌已被清掉，此时靠首次访问换来的 HttpOnly cookie 继续；
  // cookie 也没了的时候，各面板自己的请求会失败并显示重新打开设置的提示。
  mountProtocolSelect();
  mountBalanceSelect();
  syncProtocolFields();
  wireAiPanel();
  if (!byId('pet-cards')?.dataset.reactMounted) byId('pet-save').addEventListener('click', savePets);
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  // 目录先于配置渲染：voiceCard 要用它决定下拉里有哪些音色与识别实现
  if (!byId('pet-cards')?.dataset.reactMounted) loadVoiceCatalog().then(loadPets);
  loadAi();
  loadMigrationRecovery();
}
`;
}
