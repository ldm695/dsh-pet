'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createNotificationRevisionGate } = require('./notification-revisions.js');

test('one shared DSH notification revision is claimed once by one, two, or three renderers', () => {
  for (const rendererCount of [1, 2, 3]) {
    const gate = createNotificationRevisionGate();
    const accepted = Array.from({ length: rendererCount }, () => gate.claim(1700000000001));
    assert.equal(accepted.filter(Boolean).length, 1);
  }
});

test('different DSH notification revisions each pass and are not merged by content', () => {
  const gate = createNotificationRevisionGate();
  assert.equal(gate.claim(1700000000001), true);
  assert.equal(gate.claim(1700000000002), true);
  assert.equal(gate.claim(1700000000001), false);
  assert.equal(gate.claim(1700000000002), false);
});

test('invalid and empty state counters cannot trigger a notification', () => {
  const gate = createNotificationRevisionGate();
  for (const revision of [undefined, null, 0, -1, 1.5, '1700000000001']) {
    assert.equal(gate.claim(revision), false);
  }
});
