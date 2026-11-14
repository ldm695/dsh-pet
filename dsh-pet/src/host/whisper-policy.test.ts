import { test } from 'node:test';
import assert from 'node:assert/strict';

import { automaticWhisperSchedule, isDeepSeekOffPeak } from './whisper-policy.ts';

test('DeepSeek 谷价按北京时间工作日峰时和周末全天判定', () => {
  assert.equal(isDeepSeekOffPeak(new Date('2026-11-16T00:59:00Z')), true); // 周一 08:59
  assert.equal(isDeepSeekOffPeak(new Date('2026-11-16T01:00:00Z')), false); // 周一 09:00
  assert.equal(isDeepSeekOffPeak(new Date('2026-11-16T03:59:00Z')), false); // 周一 11:59
  assert.equal(isDeepSeekOffPeak(new Date('2026-11-16T04:00:00Z')), true); // 周一 12:00
  assert.equal(isDeepSeekOffPeak(new Date('2026-11-16T06:00:00Z')), false); // 周一 14:00
  assert.equal(isDeepSeekOffPeak(new Date('2026-11-16T10:00:00Z')), true); // 周一 18:00
  assert.equal(isDeepSeekOffPeak(new Date('2026-11-14T02:00:00Z')), true); // 周六
});

test('自动碎碎念需同时满足宠物开关、AI 就绪与全局峰谷策略', () => {
  const ready = { isReady: () => true, allowsAutomaticWhisper: () => false };
  assert.deepEqual(automaticWhisperSchedule(ready, true, 300), { enabled: false, periodSec: 300 });
  assert.deepEqual(automaticWhisperSchedule(ready, false, 300), { enabled: false, periodSec: 300 });
  assert.deepEqual(automaticWhisperSchedule({ isReady: () => true, allowsAutomaticWhisper: () => true }, true, 600), {
    enabled: true,
    periodSec: 600,
  });
});
