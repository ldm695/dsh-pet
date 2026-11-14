import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProtectedApiKey, saveProtectedApiKey } from './api-key-store.ts';

test('密钥单独原子存放并可清除', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-key-'));
  const directory = join(home, 'dsh-pet');
  mkdirSync(directory);
  const path = join(directory, 'standalone-ai.key');
  try {
    assert.equal(loadProtectedApiKey(path), undefined);
    saveProtectedApiKey(path, 'synthetic-test-key');
    assert.equal(loadProtectedApiKey(path), 'synthetic-test-key');
    saveProtectedApiKey(path, undefined);
    assert.equal(loadProtectedApiKey(path), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('密钥文件拒绝符号链接', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-key-link-'));
  const directory = join(home, 'dsh-pet');
  mkdirSync(directory);
  const target = join(home, 'outside.key');
  const link = join(directory, 'standalone-ai.key');
  try {
    saveProtectedApiKey(target, 'synthetic-test-key');
    symlinkSync(target, link);
    assert.throws(() => loadProtectedApiKey(link), /Unsafe credential file/);
    assert.equal(readlinkSync(link), target);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
