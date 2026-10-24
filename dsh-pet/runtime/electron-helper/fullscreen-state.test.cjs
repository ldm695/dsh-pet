'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { FullscreenDisplayStabilizer } = require('./fullscreen-state.js');

test('initial fullscreen sample is accepted without a startup delay', () => {
  const state = new FullscreenDisplayStabilizer(2);
  assert.deepEqual([...state.update([])], []);
  assert.deepEqual([...state.update(['left'])], []);
  assert.deepEqual([...state.update(['left'])], ['left']);
});

test('one-sample detector flicker does not cause hide and show transitions', () => {
  const state = new FullscreenDisplayStabilizer(2);
  state.update(['left']);
  assert.deepEqual([...state.update([])], ['left']);
  assert.deepEqual([...state.update(['left'])], ['left']);
  assert.deepEqual([...state.update([])], ['left']);
  assert.deepEqual([...state.update([])], []);
});

test('monitor identity changes are stabilized independently and compared without order', () => {
  const state = new FullscreenDisplayStabilizer(2);
  state.update(['left', 'right']);
  assert.deepEqual([...state.update(['right'])], ['left', 'right']);
  assert.deepEqual([...state.update(['right'])], ['right']);
});
