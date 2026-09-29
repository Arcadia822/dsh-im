import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/channels/feishu/state-store.mjs';
import { FeishuRuntime } from '../src/channels/feishu/feishu-runtime.mjs';
import { MultiBotDshFeishuController } from '../src/channels/feishu/multi-bot-controller.mjs';
import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';
import { DeliveryService } from '../plugin-src/host/delivery-service.mjs';
import {
  createFeishuSessionReplyRouter,
  installFeishuSessionReplyRouter,
} from '../plugin-src/host/feishu-session-reply-router.mjs';

class FakeClient {
  static instances = [];
  static sent = [];
  static replies = [];
  static gets = [];
  static lists = [];
  static listHandler = null;
  static getHandler = null;

  constructor(options) {
    this.options = options;
    this.im = {
      v1: {
        message: {
          create: async (payload) => {
            FakeClient.sent.push(payload);
            return { code: 0, data: { message_id: `message-${FakeClient.sent.length}` } };
          },
          reply: async (payload) => {
            FakeClient.replies.push(payload);
            return { code: 0, data: { message_id: 'om_reply_id', thread_id: 'omt_mock_thread' } };
          },
          get: async (payload) => {
            FakeClient.gets.push(payload);
            if (FakeClient.getHandler) return FakeClient.getHandler(payload);
            return { code: 0, data: { items: [] } };
          },
          list: async (payload) => {
            FakeClient.lists.push(payload);
            if (FakeClient.listHandler) return FakeClient.listHandler(payload);
            return { code: 0, data: { items: [], has_more: false } };
          },
        },
      },
    };
    FakeClient.instances.push(this);
  }
}

class FakeDispatcher {
  register(handlers) {
    this.handlers = handlers;
    return this;
  }
}

class FakeWSClient {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.state = 'idle';
    FakeWSClient.instances.push(this);
  }

  async start({ eventDispatcher } = {}) {
    this.state = 'connecting';
    this.dispatcher = eventDispatcher;
  }

  becomeReady() {
    this.state = 'connected';
    this.options.onReady();
  }

  fail(error = new Error('synthetic WebSocket failure')) {
    this.state = 'failed';
    this.options.onError(error);
  }

  close() {
    this.state = 'closed';
  }
}

function fakeLark() {
  FakeWSClient.instances.length = 0;
  FakeClient.instances.length = 0;
  FakeClient.sent.length = 0;
  FakeClient.replies.length = 0;
  FakeClient.gets.length = 0;
  FakeClient.lists.length = 0;
  FakeClient.listHandler = null;
  FakeClient.getHandler = null;
  return {
    Domain: { Feishu: 'feishu-domain', Lark: 'lark-domain' },
    LoggerLevel: { info: 'info' },
    Client: FakeClient,
    EventDispatcher: FakeDispatcher,
    WSClient: FakeWSClient,
    defaultHttpInstance: {
      request: async (options) => options,
    },
  };
}

async function createStartedRuntime({
  botId = 'feishu_bot_1',
  state,
  harnessBaseUrl,
  getHandler,
  listHandler,
} = {}) {
  const lark = fakeLark();
  FakeClient.getHandler = getHandler ?? null;
  FakeClient.listHandler = listHandler ?? null;

  const runtime = new FeishuRuntime({
    lark,
    botId,
    appId: 'cli_test',
    appSecret: 'secret',
    ownerOpenIds: ['ou_test_owner'],
    harness: {
      async ensureRunning() {},
      async createSession() { return 'sess_harness'; },
      async sessionExists() { return true; },
    },
    state,
    harnessBaseUrl,
  });

  const starting = runtime.start();
  for (let attempt = 0; attempt < 100 && FakeWSClient.instances.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(FakeWSClient.instances[0], 'runtime started Feishu WebSocket');
  FakeWSClient.instances[0].becomeReady();
  await starting;
  return runtime;
}

test('StateStore persists and restores threadRoots separately from topics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-native-thread-'));
  const statePath = join(dir, 'state.json');
  const store = await new StateStore(statePath).load();

  assert.equal(store.threadRootFor('omt_thread_1'), null);
  await store.setThreadRoot('omt_thread_1', {
    rootMessageId: 'om_root_1',
    chatId: 'oc_chat_1',
  });

  assert.deepEqual(store.threadRootFor('omt_thread_1'), {
    rootMessageId: 'om_root_1',
    chatId: 'oc_chat_1',
  });
  assert.equal(store.threadIdForNativeThread('oc_chat_1', 'om_root_1'), 'omt_thread_1');
  assert.equal(store.threadIdForNativeThread('oc_other_chat', 'om_root_1'), null);

  // Topics remains empty, preserving native thread route without managed topic coercion
  assert.equal(store.topicRootFor('omt_thread_1'), null);

  // Survives restart
  const reloaded = await new StateStore(statePath).load();
  assert.deepEqual(reloaded.threadRootFor('omt_thread_1'), {
    rootMessageId: 'om_root_1',
    chatId: 'oc_chat_1',
  });
  assert.equal(reloaded.topicRootFor('omt_thread_1'), null);
});

test('conversationContextForSession includes rootMessageId only when verified from persisted thread route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-ctx-test-'));
  const statePath = join(dir, 'state.json');
  const state = await new StateStore(statePath).load();

  const runtime = await createStartedRuntime({
    botId: 'feishu_bot_1',
    state,
  });

  // 1. Plain group session -> no threadId, no rootMessageId
  await state.setSession('group:oc_chat_1', 'sess_group');
  const groupCtx = runtime.conversationContextForSession('sess_group');
  assert.deepEqual(groupCtx, {
    botId: 'feishu_bot_1',
    chatId: 'oc_chat_1',
  });

  // 2. Native thread without stored root -> includes threadId, but NO rootMessageId
  await state.setSession('group:oc_chat_1:thread:omt_native_1', 'sess_thread_no_root');
  const threadNoRootCtx = runtime.conversationContextForSession('sess_thread_no_root');
  assert.deepEqual(threadNoRootCtx, {
    botId: 'feishu_bot_1',
    chatId: 'oc_chat_1',
    threadId: 'omt_native_1',
  });

  // 3. Native thread with stored root in threadRoots -> includes both threadId and verified rootMessageId
  await state.setSession('group:oc_chat_1:thread:omt_native_2', 'sess_thread_with_root');
  await state.setThreadRoot('omt_native_2', {
    rootMessageId: 'om_verified_root',
    chatId: 'oc_chat_1',
  });
  const threadWithRootCtx = runtime.conversationContextForSession('sess_thread_with_root');
  assert.deepEqual(threadWithRootCtx, {
    botId: 'feishu_bot_1',
    chatId: 'oc_chat_1',
    threadId: 'omt_native_2',
    rootMessageId: 'om_verified_root',
  });

  // 4. Stored root for different chatId -> rejected, rootMessageId omitted
  await state.setSession('group:oc_chat_1:thread:omt_native_3', 'sess_thread_wrong_chat');
  await state.setThreadRoot('omt_native_3', {
    rootMessageId: 'om_other_root',
    chatId: 'oc_different_chat',
  });
  const wrongChatCtx = runtime.conversationContextForSession('sess_thread_wrong_chat');
  assert.deepEqual(wrongChatCtx, {
    botId: 'feishu_bot_1',
    chatId: 'oc_chat_1',
    threadId: 'omt_native_3',
  });
});

test('ensureFeishuThreadSession rejects forged rootMessageId, forged threadId, root-only without thread, and cross-group mismatches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-proof-test-'));
  const statePath = join(dir, 'state.json');
  const state = await new StateStore(statePath).load();

  const messages = new Map([
    ['om_valid_root', {
      message_id: 'om_valid_root',
      chat_id: 'oc_chat_1',
      thread_id: 'omt_thread_1',
      deleted: false,
    }],
    ['om_root_no_thread', {
      message_id: 'om_root_no_thread',
      chat_id: 'oc_chat_1',
      deleted: false,
    }],
    ['om_deleted_root', {
      message_id: 'om_deleted_root',
      chat_id: 'oc_chat_1',
      deleted: true,
    }],
    ['om_wrong_root_same_chat', {
      message_id: 'om_wrong_root_same_chat',
      chat_id: 'oc_chat_1',
      deleted: false,
    }],
    ['om_reply_not_root', {
      message_id: 'om_reply_not_root',
      chat_id: 'oc_chat_1',
      thread_id: 'omt_thread_1',
      root_id: 'om_valid_root',
      deleted: false,
    }],
    ['om_foreign_root', {
      message_id: 'om_foreign_root',
      chat_id: 'oc_chat_2',
      deleted: false,
    }],
  ]);

  const threads = new Map([
    ['omt_thread_1', [
      { message_id: 'om_valid_root', chat_id: 'oc_chat_1', thread_id: 'omt_thread_1', root_id: 'om_valid_root' },
      { message_id: 'om_msg_2', chat_id: 'oc_chat_1', thread_id: 'omt_thread_1', root_id: 'om_valid_root' },
    ]],
    ['omt_foreign_thread', [
      { message_id: 'om_foreign_msg', chat_id: 'oc_chat_2', thread_id: 'omt_foreign_thread' },
    ]],
  ]);

  const runtime = await createStartedRuntime({
    botId: 'feishu_bot_1',
    state,
    getHandler: async (payload) => {
      const msg = messages.get(payload?.path?.message_id);
      if (!msg) return { code: 99991663, msg: 'not found' };
      return { code: 0, data: { items: [msg] } };
    },
    listHandler: async (payload) => {
      const threadId = payload?.params?.container_id;
      const list = threads.get(threadId);
      if (!list || list.length === 0) return { code: 0, data: { items: [], has_more: false } };
      return { code: 0, data: { items: list, has_more: false } };
    },
  });

  // Bind sender group session
  await state.setSession('group:oc_chat_1', 'sess_sender_group');

  const controller = new MultiBotDshFeishuController({
    registerApp: () => {},
    verifyApp: () => ({ ok: true }),
    credentials: { resolve: async () => ({ value: 'secret' }) },
    configStore: { list: () => [{ id: 'feishu_bot_1', appId: 'cli_test', secretRef: 'test_secret_ref' }] },
    createRuntime: () => runtime,
  });
  await controller.initialize();

  const workspaces = {
    has: () => true,
    listBotIds: () => ['feishu_bot_1'],
    conversationWorkspaceFor: () => '/test/workspace',
    agentPresetFor: () => 'standard',
  };

  const adapter = createDeliveryAdapter({
    channel: 'feishu',
    workspaces,
    coreController: controller,
    stateFor: async () => state,
  });

  const deliveryService = new DeliveryService();
  deliveryService.registerAdapter(adapter);

  const sessionController = {
    created: [],
    create: async (opts) => { sessionController.created.push(opts); return { agent: {} }; },
    resolveAgent: async (id) => ({ agent: { id } }),
  };

  // 1. Missing sender session -> forbidden
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_unknown',
      threadId: 'omt_thread_1',
      sessionController,
    }),
    (err) => err?.code === 'forbidden',
  );

  // 2. sessionController absent -> bad-request (do not bind nonexistent session)
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      threadId: 'omt_thread_1',
      rootMessageId: 'om_valid_root',
      sessionController: null,
    }),
    (err) => err?.code === 'bad-request',
  );

  // 3. Forged non-existent root message -> target-rejected
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      rootMessageId: 'om_non_existent',
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );

  // 4. Forged deleted root message -> target-rejected
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      rootMessageId: 'om_deleted_root',
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );

  // 5. Cross-group root message -> target-rejected
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      rootMessageId: 'om_foreign_root', // belongs to oc_chat_2
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );

  // 6. Forged threadId with empty history list -> target-rejected (fail closed on empty list)
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      threadId: 'omt_empty_history',
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );

  // 7. Cross-group thread -> target-rejected
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      threadId: 'omt_foreign_thread', // belongs to oc_chat_2
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );

  // 8. Root message and thread ID mismatch -> target-rejected
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      rootMessageId: 'om_valid_root', // thread_id is omt_thread_1
      threadId: 'omt_different_thread',
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );

  // 9. Root-only without verified threadId must reject (not substitute rootMessageId as threadId)
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      rootMessageId: 'om_root_no_thread',
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );

  // A message in the same group is not proof of belonging to the requested thread.
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      rootMessageId: 'om_wrong_root_same_chat',
      threadId: 'omt_thread_1',
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );
  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_sender_group',
      rootMessageId: 'om_reply_not_root',
      threadId: 'omt_thread_1',
      sessionController,
    }),
    (err) => err?.code === 'target-rejected',
  );

  // Verify that NO session was created in sessionController during all these failed attempts!
  assert.equal(sessionController.created.length, 0);
});

test('ensureFeishuThreadSession successfully adopts deterministic session, binds state before followup, and reuses on restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-success-test-'));
  const statePath = join(dir, 'state.json');
  const state = await new StateStore(statePath).load();

  const messages = new Map([
    ['om_valid_root', {
      message_id: 'om_valid_root',
      chat_id: 'oc_chat_1',
      thread_id: 'omt_thread_1',
      deleted: false,
    }],
  ]);

  const threads = new Map([
    ['omt_thread_1', [
      { message_id: 'om_valid_root', chat_id: 'oc_chat_1', thread_id: 'omt_thread_1', root_id: 'om_valid_root' },
      { message_id: 'om_reply_1', chat_id: 'oc_chat_1', thread_id: 'omt_thread_1', root_id: 'om_valid_root' },
    ]],
  ]);

  const runtime = await createStartedRuntime({
    botId: 'feishu_bot_1',
    state,
    getHandler: async (payload) => {
      const msg = messages.get(payload?.path?.message_id);
      return { code: 0, data: { items: msg ? [msg] : [] } };
    },
    listHandler: async (payload) => {
      const list = threads.get(payload?.params?.container_id) ?? [];
      return { code: 0, data: { items: list, has_more: false } };
    },
  });

  const sessionController = {
    created: [],
    agents: new Map(),
    create: async (opts) => {
      sessionController.created.push(opts);
      sessionController.agents.set(opts.sessionId, { id: opts.sessionId });
      return { agent: { id: opts.sessionId } };
    },
    resolveAgent: async (id) => {
      const agent = sessionController.agents.get(id);
      if (!agent) return { error: { message: 'not found' } };
      return { agent };
    },
  };

  const workspaces = {
    conversationWorkspaceFor: (botId) => `/workspaces/${botId}`,
    agentPresetFor: () => 'standard-preset',
  };

  // First call: creates and binds session
  const result1 = await runtime.ensureFeishuThreadSession({
    chatId: 'oc_chat_1',
    threadId: 'omt_thread_1',
    rootMessageId: 'om_valid_root',
    requestId: 'req_1',
    sessionController,
    workspaces,
  });

  assert.equal(result1.botId, 'feishu_bot_1');
  assert.equal(result1.chatId, 'oc_chat_1');
  assert.equal(result1.threadId, 'omt_thread_1');
  assert.equal(result1.rootMessageId, 'om_valid_root');
  assert.match(result1.sessionId, /^feishu-th-[a-f0-9]{16}$/);

  // Assert session was created with conversation workspace and preset
  assert.equal(sessionController.created.length, 1);
  assert.equal(sessionController.created[0].sessionId, result1.sessionId);
  assert.equal(sessionController.created[0].cwd, '/workspaces/feishu_bot_1');
  assert.equal(sessionController.created[0].agentPreset, 'standard-preset');

  // Assert native route is preserved in state, NOT coerced to managed topic
  const key = `group:oc_chat_1:thread:omt_thread_1`;
  assert.equal(state.sessionFor(key), result1.sessionId);
  assert.equal(state.sessionFor('group:oc_chat_1:managed:om_valid_root'), null);
  assert.deepEqual(state.threadRootFor('omt_thread_1'), {
    rootMessageId: 'om_valid_root',
    chatId: 'oc_chat_1',
  });

  // Second call with same parameters: returns same session idempotently without creating another session
  const result2 = await runtime.ensureFeishuThreadSession({
    chatId: 'oc_chat_1',
    threadId: 'omt_thread_1',
    rootMessageId: 'om_valid_root',
    requestId: 'req_1_retry',
    sessionController,
    workspaces,
  });
  assert.equal(result2.sessionId, result1.sessionId);
  assert.equal(sessionController.created.length, 1); // No second create call!

  // Simulate restart: reload StateStore from disk
  const reloadedState = await new StateStore(statePath).load();
  assert.equal(reloadedState.sessionFor(key), result1.sessionId);
  assert.deepEqual(reloadedState.threadRootFor('omt_thread_1'), {
    rootMessageId: 'om_valid_root',
    chatId: 'oc_chat_1',
  });

  // New runtime using reloaded state
  const restartedRuntime = await createStartedRuntime({
    botId: 'feishu_bot_1',
    state: reloadedState,
    getHandler: async (payload) => {
      const msg = messages.get(payload?.path?.message_id);
      return { code: 0, data: { items: msg ? [msg] : [] } };
    },
    listHandler: async (payload) => {
      const list = threads.get(payload?.params?.container_id) ?? [];
      return { code: 0, data: { items: list, has_more: false } };
    },
  });

  // On restart, trusted context still returns full verified rootMessageId
  const ctxOnRestart = restartedRuntime.conversationContextForSession(result1.sessionId);
  assert.deepEqual(ctxOnRestart, {
    botId: 'feishu_bot_1',
    chatId: 'oc_chat_1',
    threadId: 'omt_thread_1',
    rootMessageId: 'om_valid_root',
  });

  // Calling ensure on restart reuses existing binding
  const resultOnRestart = await restartedRuntime.ensureFeishuThreadSession({
    chatId: 'oc_chat_1',
    threadId: 'omt_thread_1',
    rootMessageId: 'om_valid_root',
    sessionController,
    workspaces,
  });
  assert.equal(resultOnRestart.sessionId, result1.sessionId);
  assert.equal(sessionController.created.length, 1);
});

test('ensureFeishuThreadSession fails closed if channel uses remote harnessBaseUrl', async () => {
  const deliveryService = new DeliveryService({
    unavailableSessionSyncChannels: ['feishu'],
  });

  const adapter = {
    channel: 'feishu',
    ownsBot: () => true,
    listBots: () => ['feishu_remote_bot'],
    listTargets: async () => [],
    listSuggestions: async () => [],
    createTarget: async () => {},
    updateTarget: async () => {},
    deleteTarget: async () => {},
    sendText: async () => ({ sent: true }),
    conversationContextForSession: () => ({ botId: 'feishu_remote_bot', chatId: 'oc_remote' }),
    ensureFeishuThreadSession: async () => assert.fail('must not be called'),
  };
  deliveryService.registerAdapter(adapter);

  await assert.rejects(
    deliveryService.ensureFeishuThreadSession({
      senderSessionId: 'sess_remote',
      threadId: 'omt_remote',
    }),
    (err) => err?.code === 'remote-harness-unsupported',
  );
});

test('Feishu session reply router delivers completed assistant reply to verified thread and preserves status across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-feishu-router-test-'));
  const routerStateFile = join(dir, 'router-state.json');

  const sentMessages = [];
  const mockDeliveryService = {
    async conversationContextForSession(sessionId) {
      if (sessionId === 'sess_thread_verified') {
        return {
          botId: 'bot_feishu_1',
          chatId: 'oc_group_123',
          threadId: 'omt_thread_456',
          rootMessageId: 'om_root_789',
        };
      }
      return null;
    },
    async send(botId, target, text, options) {
      sentMessages.push({ botId, target, text, options });
      return { sent: true, messageId: 'om_reply_sent_1' };
    },
  };

  const listeners = [];
  const mockCtx = {
    on: (event, handler) => {
      if (event === 'session/event') {
        listeners.push(handler);
        return () => {
          const idx = listeners.indexOf(handler);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      }
      return () => {};
    },
  };

  const router = installFeishuSessionReplyRouter(mockCtx, mockDeliveryService, {
    stateFile: routerStateFile,
  });
  const fireEvent = (session, event) => {
    for (const listener of listeners) listener(session, event);
  };

  const sessionObj = { id: 'sess_thread_verified' };
  const receiptId = 'rcpt_plugin_001';

  // 1. user/message from plugin
  fireEvent(sessionObj, {
    type: 'user/message',
    data: {
      turn: 1,
      source: {
        kind: 'plugin:dsh-im-session-tools',
        receiptId,
        requestId: 'req_001',
        sourceSessionId: 'sess_caller',
      },
    },
  });

  await router.whenIdle();
  assert.equal((await router.replyStatusForReceipt(receiptId))?.status, 'running');
  assert.equal((await mockDeliveryService.replyStatusForReceipt(receiptId))?.status, 'running');

  // 2. step/start
  fireEvent(sessionObj, {
    type: 'step/start',
    data: { turn: 1, step: 0 },
  });

  // 3. assistant/chunk (streaming text)
  fireEvent(sessionObj, {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: '你好，我是' },
    },
  });
  fireEvent(sessionObj, {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: '独立 Session 助手。' },
    },
  });

  // 4. step/end
  fireEvent(sessionObj, {
    type: 'step/end',
    data: { turn: 1, step: 0 },
  });

  // 5. turn/end completed
  fireEvent(sessionObj, {
    type: 'turn/end',
    data: { turn: 1, reason: 'completed' },
  });

  await router.whenIdle();

  // Assert sent strictly into the thread via rootMessageId + replyInThread
  assert.equal(sentMessages.length, 1);
  const sendCall = sentMessages[0];
  assert.equal(sendCall.botId, 'bot_feishu_1');
  assert.deepEqual(sendCall.target, { kind: 'group', route: { chatId: 'oc_group_123' } });
  assert.equal(sendCall.text, '你好，我是独立 Session 助手。');
  assert.equal(sendCall.options.replyToMessageId, 'om_root_789');
  assert.equal(sendCall.options.replyInThread, true);

  // Assert reply status
  const status = await router.replyStatusForReceipt(receiptId);
  assert.deepEqual(status, {
    status: 'delivered',
    receiptId: 'rcpt_plugin_001',
    messageId: 'om_reply_sent_1',
    threadId: 'omt_thread_456',
    rootMessageId: 'om_root_789',
    sentAt: status.sentAt,
  });

  // Restart simulation: new router loading from the same stateFile preserves receipt status
  const restartedRouter = createFeishuSessionReplyRouter({
    deliveryService: mockDeliveryService,
    stateFile: routerStateFile,
  });
  await restartedRouter.whenIdle();
  assert.deepEqual(await restartedRouter.replyStatusForReceipt(receiptId), status);
});

test('a queued inbox splice cannot attach another turn’s answer to a Feishu thread', async () => {
  const sent = [];
  const router = createFeishuSessionReplyRouter({
    deliveryService: {
      conversationContextForSession: async () => ({
        botId: 'bot', chatId: 'chat', threadId: 'thread', rootMessageId: 'root',
      }),
      send: async (...args) => { sent.push(args); },
    },
    stateFile: ':memory:',
  });
  await router.enqueue('thread-session', {
    type: 'agent/inbox/spliced',
    data: { inserted: [{ source: { kind: 'plugin:dsh-im-session-tools', receiptId: 'queued-receipt' } }] },
  });
  await router.enqueue('thread-session', { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
  assert.equal(sent.length, 0);
  assert.equal(await router.replyStatusForReceipt('queued-receipt'), null);
  router.close();
});

test('Feishu session reply router reports errors to thread and drops if rootMessageId is missing (never main feed), and send errors remain retryable', async () => {
  const sentMessages = [];
  let shouldFailSend = false;

  const mockDeliveryService = {
    async conversationContextForSession(sessionId) {
      if (sessionId === 'sess_thread_ok') {
        return {
          botId: 'bot_feishu_1',
          chatId: 'oc_group_123',
          threadId: 'omt_thread_456',
          rootMessageId: 'om_root_789',
        };
      }
      if (sessionId === 'sess_group_only') {
        return {
          botId: 'bot_feishu_1',
          chatId: 'oc_group_123',
        };
      }
      return null;
    },
    async send(botId, target, text, options) {
      if (shouldFailSend) {
        const error = new Error('Feishu network glitch');
        error.code = 'delivery-failed';
        throw error;
      }
      sentMessages.push({ botId, target, text, options });
      return { sent: true, messageId: 'om_err_msg' };
    },
  };

  const listeners = [];
  const mockCtx = {
    on: (event, handler) => {
      listeners.push(handler);
      return () => {};
    },
  };

  const router = installFeishuSessionReplyRouter(mockCtx, mockDeliveryService, { stateFile: ':memory:' });
  const fireEvent = (session, event) => {
    for (const listener of listeners) listener(session, event);
  };

  // Case 1: Turn fails with model error -> error reported to Thread with replyInThread
  fireEvent({ id: 'sess_thread_ok' }, {
    type: 'user/message',
    data: {
      turn: 1,
      source: {
        kind: 'plugin:dsh-im-session-tools',
        receiptId: 'rcpt_fail_001',
      },
    },
  });

  fireEvent({ id: 'sess_thread_ok' }, {
    type: 'turn/end',
    data: {
      turn: 1,
      reason: { kind: 'error', message: 'Model rate limit exceeded' },
    },
  });

  await router.whenIdle();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].options.replyToMessageId, 'om_root_789');
  assert.equal(sentMessages[0].options.replyInThread, true);
  assert.match(sentMessages[0].text, /Model rate limit exceeded/);

  const failStatus = await router.replyStatusForReceipt('rcpt_fail_001');
  assert.equal(failStatus.status, 'failed');
  assert.equal(failStatus.error, 'Model rate limit exceeded');

  // Case 2: Session lacks rootMessageId -> MUST NOT send to main feed! Drop and record failure!
  sentMessages.length = 0;
  fireEvent({ id: 'sess_group_only' }, {
    type: 'user/message',
    data: {
      turn: 1,
      source: {
        kind: 'plugin:dsh-im-session-tools',
        receiptId: 'rcpt_no_root_002',
      },
    },
  });

  fireEvent({ id: 'sess_group_only' }, {
    type: 'turn/end',
    data: { turn: 1, reason: 'completed' },
  });

  await router.whenIdle();

  assert.equal(sentMessages.length, 0); // Not sent to main feed!
  const droppedStatus = await router.replyStatusForReceipt('rcpt_no_root_002');
  assert.equal(droppedStatus.status, 'failed');
  assert.match(droppedStatus.error, /missing verified rootMessageId/);

  // Case 3: Send error during delivery remains retryable
  shouldFailSend = true;
  fireEvent({ id: 'sess_thread_ok' }, {
    type: 'user/message',
    data: {
      turn: 2,
      source: {
        kind: 'plugin:dsh-im-session-tools',
        receiptId: 'rcpt_retryable_003',
      },
    },
  });
  fireEvent({ id: 'sess_thread_ok' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 2,
      message: { content: [{ type: 'text', text: 'Retryable answer' }] },
    },
  });
  fireEvent({ id: 'sess_thread_ok' }, {
    type: 'turn/end',
    data: { turn: 2, reason: 'completed' },
  });
  await router.whenIdle();

  const retryableStatus = await router.replyStatusForReceipt('rcpt_retryable_003');
  assert.equal(retryableStatus.status, 'failed');
  assert.equal(retryableStatus.retryable, true);
  assert.match(retryableStatus.error, /Feishu network glitch/);

  // Now network recovers: retrying the turn event succeeds
  shouldFailSend = false;
  fireEvent({ id: 'sess_thread_ok' }, {
    type: 'user/message',
    data: {
      turn: 2,
      source: {
        kind: 'plugin:dsh-im-session-tools',
        receiptId: 'rcpt_retryable_003',
      },
    },
  });
  fireEvent({ id: 'sess_thread_ok' }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn: 2,
      message: { content: [{ type: 'text', text: 'Retryable answer' }] },
    },
  });
  fireEvent({ id: 'sess_thread_ok' }, {
    type: 'turn/end',
    data: { turn: 2, reason: 'completed' },
  });
  await router.whenIdle();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, 'Retryable answer');
  assert.equal((await router.replyStatusForReceipt('rcpt_retryable_003')).status, 'delivered');
});
