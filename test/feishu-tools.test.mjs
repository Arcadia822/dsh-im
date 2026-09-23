import assert from 'node:assert/strict';
import test from 'node:test';

import { installFeishuTools } from '../plugin-src/host/feishu-tools.mjs';

function installedTools(service) {
  const definitions = [];
  assert.equal(installFeishuTools({ tools: { register: (tool) => definitions.push(tool) } }, service), true);
  return new Map(definitions.map((tool) => [tool.name, tool]));
}

test('Feishu send tool describes the one-shot auto/card formats', () => {
  const send = installedTools({}).get('dsh_im_feishu_send');
  assert.deepEqual(send.parameters.properties.format.enum, ['auto', 'plain', 'markdown', 'card']);
  assert.match(send.description, /no Agent turn or stream/);
  assert.match(send.parameters.properties.format.description, /valid card JSON/);
});

test('Feishu tools support explicit botId and targetId', async () => {
  const calls = [];
  const tools = installedTools({
    listBots: async () => [{ botId: 'bot_one', channel: 'feishu' }],
    listMessages: async (...args) => {
      calls.push(['list', ...args]);
      return { items: [{ messageId: 'om_root', threadId: 'omt_topic' }], hasMore: false };
    },
    send: async (...args) => {
      calls.push(['send', ...args]);
      return { sent: true, messageId: 'om_reply', threadId: 'omt_topic', rootId: 'om_root' };
    },
  });

  const history = await tools.get('dsh_im_feishu_list_messages').execute({
    botId: 'bot_one', targetId: 'reports', pageSize: 20,
  });
  const receipt = await tools.get('dsh_im_feishu_send').execute({
    botId: 'bot_one', targetId: 'reports', text: '继续讨论',
    format: 'markdown', replyToMessageId: 'om_root', replyInThread: true,
  });

  assert.equal(history.items[0].messageId, 'om_root');
  assert.equal(receipt.threadId, 'omt_topic');
  assert.deepEqual(calls, [
    ['list', 'bot_one', 'reports', { pageSize: 20 }],
    ['send', 'bot_one', 'reports', '继续讨论', {
      format: 'markdown', replyToMessageId: 'om_root', replyInThread: true,
    }],
  ]);
});

test('Feishu tools auto-resolve botId and targetId from active session', async () => {
  const calls = [];
  const tools = installedTools({
    listBots: async () => [{ botId: 'bot_auto', channel: 'feishu' }],
    listTargets: async () => ({
      targets: [{ targetId: 'tgt_group_1', kind: 'group', route: { chatId: 'oc_123' } }],
    }),
    conversationContextForSession: async (id) => {
      if (id === 'sess_active') {
        return { botId: 'bot_auto', chatId: 'oc_123', threadId: 'omt_current_thread' };
      }
      return null;
    },
    listMessages: async (...args) => {
      calls.push(['list', ...args]);
      return { items: [{ messageId: 'om_in_thread' }], hasMore: false };
    },
    send: async (...args) => {
      calls.push(['send', ...args]);
      return { sent: true, messageId: 'om_reply' };
    },
  });

  const execContext = {
    agent: {
      session: { header: { id: 'sess_active' } },
    },
  };

  // 1. In a thread session, omitting threadId defaults to current thread
  const history = await tools.get('dsh_im_feishu_list_messages').execute({}, execContext);
  assert.equal(history.items[0].messageId, 'om_in_thread');
  assert.deepEqual(calls[0], ['list', 'bot_auto', 'tgt_group_1', { threadId: 'omt_current_thread' }]);

  // 2. Can explicitly override threadId to query another thread in same group
  await tools.get('dsh_im_feishu_list_messages').execute({ threadId: 'omt_other_thread' }, execContext);
  assert.deepEqual(calls[1], ['list', 'bot_auto', 'tgt_group_1', { threadId: 'omt_other_thread' }]);

  // 3. Send automatically resolves targetId
  await tools.get('dsh_im_feishu_send').execute({ text: '自动定位回复' }, execContext);
  assert.deepEqual(calls[2], ['send', 'bot_auto', 'tgt_group_1', '自动定位回复', {
    format: undefined, replyToMessageId: undefined, replyInThread: undefined,
  }]);
});

test('Feishu tools reject a non-Feishu bot before touching delivery methods', async () => {
  let called = false;
  const tools = installedTools({
    listBots: async () => [{ botId: 'bot_one', channel: 'telegram' }],
    listMessages: async () => { called = true; },
    send: async () => { called = true; },
  });

  await assert.rejects(
    tools.get('dsh_im_feishu_list_messages').execute({ botId: 'bot_one', targetId: 'reports' }),
    (error) => error?.code === 'unknown-bot',
  );
  assert.equal(called, false);
});
