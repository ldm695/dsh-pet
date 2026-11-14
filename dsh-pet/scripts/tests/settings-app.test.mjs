// Browser integration check for the combined standalone React settings application.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';

test('standalone React settings keeps AI controls, context settings and tab navigation live', async (t) => {
  const script = readFileSync(join(process.cwd(), 'lib', 'settings-app.js'), 'utf8');
  const browser = await chromium.launch();
  t.after(() => browser.close());

  const ai = {
    protocol: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model-x',
    balanceProvider: '',
    hasKey: false,
    hasDeepseekKey: false,
    chatEnabled: true,
    automaticWhispers: false,
    whispersOnlyOffPeak: false,
    chatMemoryRounds: 5,
    chatImageLimit: 10,
  };
  const posts = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    const json = (value) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="settings-root"></div><script src="/settings.js"></script></body></html>',
      );
    } else if (path === '/settings.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(script);
    } else if (path === '/standalone-ai/icon.png') {
      res.writeHead(204);
      res.end();
    } else if (path === '/standalone-ai/settings' && req.method === 'GET') json(ai);
    else if (path === '/standalone-ai/settings' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const value = JSON.parse(body);
      posts.push(value);
      Object.assign(ai, value, {
        hasKey: Boolean(value.apiKey) || ai.hasKey,
        hasDeepseekKey: Boolean(value.deepseekApiKey) || ai.hasDeepseekKey,
      });
      json(ai);
    } else if (path === '/standalone-ai/test') json({ ok: true, message: '连接成功' });
    else if (path === '/standalone-ai/models') json({ ok: true, models: [{ id: 'model-y' }] });
    else if (path === '/standalone-ai/balance') json({ ok: true, shape: 'money', data: { wallets: [] } });
    else if (path === '/dsh-pet-7340/migration-recovery') json({ available: false });
    else if (path === '/dsh-pet-7340/config/meta') json({});
    else if (path === '/dsh-pet-7340/config')
      json({
        main: {
          pets: [
            {
              id: 'main',
              name: 'Pet',
              size: 320,
              assetRoot: 'main',
              display: 'web',
              position: { corner: 'bottom-right', marginX: 0, marginY: 0 },
            },
          ],
        },
      });
    else if (path === '/dsh-pet-7340/voice/voices') json({ providers: [] });
    else if (path === '/dsh-pet-7340/voice/hear-providers') json({ providers: [] });
    else if (path === '/dsh-pet-7340/state') json({});
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('tab', { name: '配置' }).click();
  await page.getByRole('heading', { name: '模型连接' }).waitFor();
  await page.getByRole('heading', { name: '对话上下文' }).waitFor();

  const inputs = page.locator('input[autocomplete="new-password"]');
  await inputs.first().fill('test-key-never-returned');
  await page.getByRole('spinbutton', { name: '对话历史轮数' }).fill('12');
  await page.getByRole('button', { name: '保存设置' }).click();
  await page.getByText('已保存到本机。', { exact: true }).waitFor();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].apiKey, 'test-key-never-returned');
  assert.equal(posts[0].chatMemoryRounds, 12);

  await page.getByRole('button', { name: '测试连接' }).click();
  await page.getByText('✓ 连接成功', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '对话' }).click();
  await page.getByRole('heading', { name: '对话' }).waitFor();
  assert.deepEqual(errors, []);
});
