import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMenuRoutes } from './menu.ts';
import { handleChatRoutes } from './chat.ts';

const input = {
  url: new URL('http://127.0.0.1/dsh-pet-7340/menu/capabilities'),
  rest: 'menu/capabilities',
  method: 'GET',
};

test('menu capabilities hide standalone chat and balance when disabled or unsupported', async () => {
  const deps = {
    ctx: {
      standaloneAi: {
        isChatEnabled: () => false,
        getSettings: () => ({ protocol: 'anthropic', balanceProvider: 'deepseek-official' }),
      },
    },
  };
  const result = await handleMenuRoutes(deps as never, input);
  assert.deepEqual(result && 'obj' in result ? result.obj : undefined, { chatEnabled: false, balanceSupported: false });
});

test('native host without standalone AI keeps its existing menu options', async () => {
  const result = await handleMenuRoutes({ ctx: {} } as never, input);
  assert.deepEqual(result && 'obj' in result ? result.obj : undefined, { chatEnabled: true, balanceSupported: true });
});

test('disabled standalone AI chat is rejected by the chat route', async () => {
  const result = await handleChatRoutes({ ctx: { standaloneAi: { isChatEnabled: () => false } } } as never, {
    url: new URL('http://127.0.0.1/dsh-pet-7340/chat?pet=main'),
    rest: 'chat',
    method: 'POST',
    body: '{"text":"hello"}',
  });
  assert.equal(result && 'obj' in result ? (result.obj as { ok?: boolean }).ok : undefined, false);
});
