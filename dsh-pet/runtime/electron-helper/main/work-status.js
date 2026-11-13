'use strict';
/**
 * Assign active DSH/Codex/Claude sessions to eligible pet windows in one shared process.
 * @module dsh-pet/runtime/electron-helper/main/work-status
 */
const { WorkStatusAssignmentManager } = require('../shared-core.js');

/** Create the process-wide work-status assignment coordinator. */
function createWorkStatusAssignments({ app, BrowserWindow, ipcMain, petWindows }) {
  const manager = new WorkStatusAssignmentManager();
  const eligiblePetIdsByRenderer = new Map();
  let sourceRendererId = null;
  let latestAgents = [];
  let latestStateCounter = -1;

  function broadcast() {
    const eligiblePetIds = [...new Set([...eligiblePetIdsByRenderer.values()].flat())];
    const result = manager.reconcile(latestAgents, eligiblePetIds);
    const payload = { agents: latestAgents, ...result };
    for (const target of new Set(petWindows.state.windows.values())) {
      if (!target.isDestroyed()) target.webContents.send('pet:work-status-assignments', payload);
    }
  }

  function acceptSnapshot(event, snapshot) {
    const sourceWindow = BrowserWindow.fromWebContents(event.sender);
    if (!sourceWindow || sourceWindow.isDestroyed() || ![...petWindows.state.windows.values()].includes(sourceWindow)) return;
    if (!Array.isArray(snapshot?.agents) || !Array.isArray(snapshot?.eligiblePetIds)) return;

    const ownedPetIds = new Set(
      [...petWindows.state.windows].filter(([, win]) => win === sourceWindow).map(([petId]) => petId),
    );
    const eligiblePetIds = snapshot.eligiblePetIds.filter(
      (petId) => typeof petId === 'string' && ownedPetIds.has(petId),
    );
    eligiblePetIdsByRenderer.set(event.sender.id, eligiblePetIds);

    if (Number.isSafeInteger(snapshot.stateCounter) && snapshot.stateCounter >= 0) {
      if (snapshot.stateCounter >= latestStateCounter) {
        latestStateCounter = snapshot.stateCounter;
        latestAgents = snapshot.agents;
        sourceRendererId = event.sender.id;
      }
    } else if (sourceRendererId === null || sourceRendererId === event.sender.id) {
      sourceRendererId = event.sender.id;
      latestAgents = snapshot.agents;
    }
    broadcast();
  }

  function releaseRenderer(rendererId) {
    eligiblePetIdsByRenderer.delete(rendererId);
    if (sourceRendererId === rendererId) sourceRendererId = null;
    if (eligiblePetIdsByRenderer.size === 0) {
      latestStateCounter = -1;
      latestAgents = [];
    }
    broadcast();
  }

  const onContentsCreated = (_event, contents) => {
    contents.once('destroyed', () => releaseRenderer(contents.id));
  };
  ipcMain.on('pet:work-status-snapshot', acceptSnapshot);
  app.on('web-contents-created', onContentsCreated);

  return {
    dispose() {
      ipcMain.removeListener('pet:work-status-snapshot', acceptSnapshot);
      app.removeListener('web-contents-created', onContentsCreated);
      for (const rendererId of eligiblePetIdsByRenderer.keys()) releaseRenderer(rendererId);
    },
  };
}

module.exports = { createWorkStatusAssignments };
