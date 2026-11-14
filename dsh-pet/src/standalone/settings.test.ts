import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicSettings, validateSettings } from './settings.ts';
import { settingsPage, settingsStyle } from './settings-page.ts';

test('settings request validation preserves write-only credentials and accepts conversation context settings', () => {
  const input = {
    protocol: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model',
    apiKey: '',
    automaticWhispers: false,
    whisperIntervalSec: 300,
    maxTokens: 512,
    chatMemoryRounds: 12,
    chatImageLimit: 8,
  };
  assert.deepEqual(validateSettings(input), input);
  assert.deepEqual(validateSettings({ clearApiKey: true }), { clearApiKey: true });
  for (const invalid of [
    null,
    [],
    { protocol: 'other' },
    { clearApiKey: 'yes' },
    { whisperIntervalSec: 59 },
    { whisperIntervalSec: 1.5 },
    { maxTokens: 99999 },
    { chatMemoryRounds: -1 },
    { chatImageLimit: 1.5 },
    { apiKey: 123 },
    { hasKey: true },
    { enabled: true },
    { baseUrl: 'file:///a' },
    { baseUrl: 'https://user:secret@example.test/v1' },
    { baseUrl: 'https://example.test/?key=secret' },
  ]) {
    assert.throws(() => validateSettings(invalid), Error, JSON.stringify(invalid));
  }
});

test('public settings filter credentials while exposing only safe context fields', () => {
  const actual = publicSettings({
    protocol: 'anthropic',
    apiKey: 'never expose',
    deepseekApiKey: 'never expose',
    token: 'never expose',
    hasKey: true,
    model: 'x',
    enabled: false,
    chatMemoryRounds: 12,
    chatImageLimit: 8,
  });
  assert.deepEqual(actual, {
    protocol: 'anthropic',
    hasKey: true,
    model: 'x',
    chatMemoryRounds: 12,
    chatImageLimit: 8,
  });
  assert.equal(JSON.stringify(actual).includes('never expose'), false);
});

test('settings document uses one React mount and no legacy form or inline code', () => {
  assert.match(settingsPage, /lang="zh-CN"/);
  assert.match(settingsPage, /id="settings-root"/);
  assert.match(settingsPage, /src="\/standalone-ai\/settings\.js"/);
  assert.doesNotMatch(settingsPage, /id="settings"|id="pet-cards"|chat-panel\.js|pet-config\.js/);
  assert.doesNotMatch(settingsPage, /<script\s*[^>]*>\s*[^<]/i);
  assert.doesNotMatch(settingsPage, /https?:\/\/(?!example)/);
  assert.match(settingsStyle, /focus-visible/);
});
