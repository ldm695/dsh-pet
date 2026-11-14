import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createNotificationRevisionGate } = require('../../runtime/electron-helper/notification-revisions.js');

test('a DSH notification revision is consumed once, while adjacent revisions remain distinct', () => {
  const gate = createNotificationRevisionGate();
  assert.equal(gate.claim(17), true);
  assert.equal(gate.claim(17), false);
  assert.equal(gate.claim(18), true);
  assert.equal(gate.claim(16), false, 'late delivery of an older state frame must not show a stale notification');
  assert.equal(gate.claim(0), false);
  assert.equal(gate.claim(Number.NaN), false);
});
