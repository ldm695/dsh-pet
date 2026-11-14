import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { createAiConfig, DEFAULT_AI_SETTINGS } from './ai-config.ts';
import { loadProtectedApiKey, saveProtectedApiKey } from './api-key-store.ts';
import { writeAiSettings } from './ai-storage.ts';
import { prepareStandaloneMigrations } from './migrations.ts';

function createLogger(messages: string[]) {
  return {
    warn(message: string) {
      messages.push(message);
    },
    info(message: string) {
      messages.push(message);
    },
  };
}

function removeTestHome(home: string): void {
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [home, '/reset', '/t', '/c', '/q'], { stdio: 'ignore', windowsHide: true });
  }
  rmSync(home, { recursive: true, force: true });
}

function createUpstreamAiSettings() {
  return {
    protocol: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'upstream-model',
    enabled: true,
    automaticWhispers: true,
    whisperIntervalSec: 300,
    maxTokens: 1024,
    timeoutMs: 30_000,
  };
}

async function seedUpstreamSettings(home: string, apiKey: string): Promise<string> {
  const directory = join(home, 'dsh-pet');
  const path = join(directory, 'standalone-ai.json');
  writeAiSettings(home, { ...DEFAULT_AI_SETTINGS, ...createUpstreamAiSettings() });
  writeFileSync(path, JSON.stringify({ ...createUpstreamAiSettings(), apiKey }));
  return path;
}

test(
  'migrates upstream config and plaintext standalone AI key without losing settings',
  { skip: process.platform !== 'win32' },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-upstream-migration-'));
    const messages: string[] = [];
    const legacyConfig = '{\n  "chatMemoryRounds": 3,\n  "chatImageLimit": 7\n}\n';
    const legacyConfigPath = join(home, 'dsh-pet', 'main-config.json');
    const currentConfigPath = join(home, 'dsh-pet', 'main-config.jsonc');
    const sourceApiKey = 'upstream-migration-test-secret';
    try {
      await seedUpstreamSettings(home, sourceApiKey);
      writeFileSync(legacyConfigPath, legacyConfig);

      const result = await prepareStandaloneMigrations({
        home,
        packageRoot: resolve('.'),
        logger: createLogger(messages),
      });

      assert.equal(result.initialApiKey, sourceApiKey);
      assert.equal(await loadProtectedApiKey(join(home, 'dsh-pet', 'standalone-ai-key.dpapi')), sourceApiKey);
      assert.equal(readFileSync(currentConfigPath, 'utf8'), legacyConfig);
      // The legacy path must remain present for rollback; the migrated active copy is byte-checked above.
      assert.equal(existsSync(legacyConfigPath), true);

      const aiSettings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
      assert.equal(Object.prototype.hasOwnProperty.call(aiSettings, 'apiKey'), false);
      assert.equal(aiSettings.model, 'upstream-model');
      assert.equal(aiSettings.chatMemoryRounds, 3);
      assert.equal(aiSettings.chatImageLimit, 7);
      assert.equal(
        messages.some((message) => message.includes('迁移到 DPAPI')),
        true,
      );
      const migratedAi = createAiConfig(home, { initialApiKey: result.initialApiKey });
      assert.equal(migratedAi.publicSettings().model, 'upstream-model');
      assert.equal(migratedAi.publicSettings().hasKey, true);

      const secondRun = await prepareStandaloneMigrations({
        home,
        packageRoot: resolve('.'),
        logger: createLogger(messages),
      });
      assert.equal(secondRun.initialApiKey, sourceApiKey);
      assert.equal(
        Object.prototype.hasOwnProperty.call(
          JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8')),
          'apiKey',
        ),
        false,
      );
    } finally {
      removeTestHome(home);
    }
  },
);

test(
  'backs up both keys and restores safe defaults when an upstream plaintext key conflicts with DPAPI',
  { skip: process.platform !== 'win32' },
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-upstream-conflict-'));
    const legacyApiKey = 'upstream-key-to-preserve';
    const currentApiKey = 'current-key-to-preserve';
    try {
      const settingsPath = await seedUpstreamSettings(home, legacyApiKey);
      const apiKeyPath = join(home, 'dsh-pet', 'standalone-ai-key.dpapi');
      await saveProtectedApiKey(apiKeyPath, currentApiKey);
      const originalSettings = readFileSync(settingsPath, 'utf8');

      const result = await prepareStandaloneMigrations({
        home,
        packageRoot: resolve('.'),
        logger: createLogger([]),
      });

      assert.equal(result.recoveredFromMigrationError, true);
      assert.ok(result.backupDirectory);
      assert.equal(
        readFileSync(join(result.backupDirectory, 'dsh-pet', 'standalone-ai.json'), 'utf8'),
        originalSettings,
      );
      const manifest = JSON.parse(readFileSync(join(result.backupDirectory, 'manifest.json'), 'utf8'));
      assert.equal(manifest.status, 'complete');
      const safeSettings = JSON.parse(readFileSync(join(home, 'dsh-pet', 'standalone-ai.json'), 'utf8'));
      assert.equal(safeSettings.automaticWhispers, false);
      assert.equal(safeSettings.apiKey, undefined);
      assert.equal(await loadProtectedApiKey(apiKeyPath), undefined);
      assert.equal(
        await loadProtectedApiKey(join(result.backupDirectory!, 'dsh-pet', 'standalone-ai-key.dpapi')),
        currentApiKey,
      );
      assert.equal(existsSync(join(home, 'dsh-pet', 'main-config.jsonc')), true);
    } finally {
      removeTestHome(home);
    }
  },
);
