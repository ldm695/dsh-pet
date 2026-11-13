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
    ],
    'openai-compatible',
    () => forgetModelOptions(),
  );
  protocolSelect.root.firstElementChild.setAttribute('aria-labelledby', 'protocol-label');
  host.append(protocolSelect.root);
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
        '还原原配置会移除当前桌宠配置、恢复迁移前备份，并立即退出桌宠进程。备份目录：\n' +
          recovery.backupDirectory +
          '\n\n确定继续吗？',
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
    // 没有迁移备份时，设置页不显示此卡片。
  }
}

function boot() {
  wireTabs();
  selectTab('chat');
  // 刷新后地址栏里的令牌已被清掉，此时靠首次访问换来的 HttpOnly cookie 继续；
  // cookie 也没了的时候，各面板自己的请求会失败并显示重新打开设置的提示。
  mountProtocolSelect();
  mountBalanceSelect();
  wireAiPanel();
  byId('pet-save').addEventListener('click', savePets);
  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  loadPets();
  loadAi();
  loadMigrationRecovery();
}
`;
}
