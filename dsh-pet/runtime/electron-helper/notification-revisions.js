'use strict';

/** Claim a shared state counter once per helper process, regardless of renderer count. */
function createNotificationRevisionGate() {
  const seen = new Set();
  return {
    claim(revision) {
      if (!Number.isSafeInteger(revision) || revision <= 0 || seen.has(revision)) return false;
      seen.add(revision);
      return true;
    },
  };
}

module.exports = { createNotificationRevisionGate };
