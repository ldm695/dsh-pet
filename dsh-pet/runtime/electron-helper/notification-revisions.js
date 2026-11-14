'use strict';

/** A shared state revision can be claimed only once by the Electron helper process. */
function createNotificationRevisionGate() {
  let lastRevision = 0;
  return {
    claim(revision) {
      if (!Number.isSafeInteger(revision) || revision <= lastRevision) return false;
      lastRevision = revision;
      return true;
    },
  };
}

module.exports = { createNotificationRevisionGate };
