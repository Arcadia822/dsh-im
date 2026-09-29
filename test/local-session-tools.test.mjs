import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createLocalSessionService,
  installLocalSessionTools,
  resolveDefaultStateFile,
  SESSION_TOOL_NAMES,
} from '../plugin-src/host/local-session-tools.mjs';

function createMockSession({
  id = 'session-test',
  cwd = '/workspace/test',
  agentPreset = 'preset-test',
  events = [],
} = {}) {
  const sessionEvents = [...events];
  return {
    header: { id, cwd, agentPreset },
    id,
    events: sessionEvents,
    snapshotEvents: () => Object.freeze([...sessionEvents]),
    append(type, data) {
      sessionEvents.push({ type, data, seq: sessionEvents.length + 1 });
    },
  };
}

function createMockAgent({
  id = 'session-test',
  cwd = '/workspace/test',
  agentPreset = 'preset-test',
  events = [],
} = {}) {
  const session = createMockSession({ id, cwd, agentPreset, events });
  const followups = [];
  return {
    id,
    session,
    followups,
    followup(message) {
      followups.push(message);
      session.append('agent/inbox/spliced', { inserted: [message] });
    },
  };
}

function createMockCtx({
  agents = new Map(),
  flushed = true,
} = {}) {
  const toolsRegistered = [];
  const createdSessions = [];

  const sessionController = {
    createdSessions,
    create: async ({ sessionId, cwd, agentPreset }) => {
      createdSessions.push({ sessionId, cwd, agentPreset });
      if (!agents.has(sessionId)) {
        agents.set(sessionId, createMockAgent({ id: sessionId, cwd, agentPreset }));
      }
      return { sessionId, agentPreset };
    },
    resolveAgent: async (sessionId) => {
      const agent = agents.get(sessionId);
      if (!agent) {
        return { error: { message: `Session ${sessionId} not found` } };
      }
      return { agent };
    },
  };

  const sessions = {
    flush: async function flush(session) {
      // Must be called with proper this context
      assert.equal(this, sessions, 'sessions.flush must be called as a method on sessions');
      if (typeof flushed === 'function') {
        return flushed(session);
      }
      return flushed === true;
    },
  };

  const tools = {
    registered: toolsRegistered,
    register: (tool) => {
      toolsRegistered.push(tool);
    },
  };

  return {
    sessionController,
    sessions,
    tools,
    agents,
  };
}

function makeExec(agent) {
  return {
    agent: agent || createMockAgent({ id: 'caller-session-1' }),
  };
}

test('1. same-ID create only one Session; requires authoritative session.header.cwd', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });

  // Missing session.header.cwd -> unauthorized
  const agentNoCwd = {
    session: {
      header: { id: 'caller-no-cwd' },
    },
  };
  await assert.rejects(
    () => service.createSession({ requestId: 'r-fail' }, { agent: agentNoCwd }),
    (err) => err.code === 'unauthorized',
  );

  const caller = createMockAgent({ id: 'caller-1', cwd: '/work/c1', agentPreset: 'dev' });
  const exec = makeExec(caller);

  const res1 = await service.createSession({ requestId: 'req-alpha' }, exec);
  assert.equal(res1.created, true);
  assert.match(res1.sessionId, /^session-local-/);
  assert.equal(res1.cwd, '/work/c1');
  assert.equal(res1.agentPreset, 'dev');
  assert.equal(ctx.sessionController.createdSessions.length, 1);

  // Retry with same requestId
  const res2 = await service.createSession({ requestId: 'req-alpha' }, exec);
  assert.equal(res2.created, false);
  assert.equal(res2.sessionId, res1.sessionId);
  assert.equal(ctx.sessionController.createdSessions.length, 1);
});

test('concurrent create with one request ID invokes Host creation only once', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const exec = makeExec(createMockAgent({ id: 'creator' }));
  const [first, second] = await Promise.all([
    service.createSession({ requestId: 'same-create' }, exec),
    service.createSession({ requestId: 'same-create' }, exec),
  ]);
  assert.equal(first.sessionId, second.sessionId);
  assert.deepEqual([first.created, second.created], [true, false]);
  assert.equal(ctx.sessionController.createdSessions.length, 1);
});


test('2. create reservation conflicts on different threadId/rootMessageId fingerprint', async () => {
  const deliveryService = {
    ensureFeishuThreadSession: async (opts) => ({
      sessionId: `session-feishu-${opts.threadId}`,
      botId: 'bot1',
      chatId: 'chat1',
      threadId: opts.threadId,
      rootMessageId: opts.rootMessageId,
    }),
  };

  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { deliveryService, stateFile: ':memory:' });
  const caller = createMockAgent({ id: 'caller-1', cwd: '/work/c1' });

  // First create with threadId: t1
  const r1 = await service.createSession({ requestId: 'req-thread', threadId: 't1' }, makeExec(caller));
  assert.equal(r1.threadId, 't1');

  // Retry with same requestId and same threadId -> returns existing
  const r2 = await service.createSession({ requestId: 'req-thread', threadId: 't1' }, makeExec(caller));
  assert.equal(r2.created, false);
  assert.equal(r2.sessionId, r1.sessionId);

  // Retry with same requestId but different threadId -> conflict!
  await assert.rejects(
    () => service.createSession({ requestId: 'req-thread', threadId: 't2' }, makeExec(caller)),
    (err) => err.code === 'request-conflict',
  );
});

test('3. two callers no collision', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });

  const callerA = createMockAgent({ id: 'caller-A', cwd: '/work/a' });
  const callerB = createMockAgent({ id: 'caller-B', cwd: '/work/b' });

  const resA = await service.createSession({ requestId: 'shared-req' }, makeExec(callerA));
  const resB = await service.createSession({ requestId: 'shared-req' }, makeExec(callerB));

  assert.notEqual(resA.sessionId, resB.sessionId);
  assert.equal(ctx.sessionController.createdSessions.length, 2);
});

test('4. same request retry no duplicate followup; mismatch conflicts across target and content', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const caller = createMockAgent({ id: 'caller-1', cwd: '/work/c1' });

  const child1 = await service.createSession({ requestId: 'req-child-1' }, makeExec(caller));
  const child2 = await service.createSession({ requestId: 'req-child-2' }, makeExec(caller));
  const targetAgent1 = ctx.agents.get(child1.sessionId);

  const receipt1 = await service.sendInput(
    { sessionId: child1.sessionId, requestId: 'send-1', text: 'Hello world!' },
    makeExec(caller),
  );
  assert.equal(receipt1.status, 'queued');
  assert.equal(targetAgent1.followups.length, 1);
  assert.equal(targetAgent1.followups[0].content[0].text, 'Hello world!');
  assert.equal(targetAgent1.followups[0].source.kind, 'plugin:dsh-im-session-tools');
  assert.equal(targetAgent1.followups[0].source.initiatorKind, 'agent');
  assert.equal(targetAgent1.followups[0].source.sourceSessionId, 'caller-1');

  // Retry with same requestId, same target, same text -> returns existing receipt without followup
  const receipt2 = await service.sendInput(
    { sessionId: child1.sessionId, requestId: 'send-1', text: 'Hello world!' },
    makeExec(caller),
  );
  assert.equal(receipt2.receiptId, receipt1.receiptId);
  assert.equal(targetAgent1.followups.length, 1);

  // Retry with same requestId but different text -> conflict
  await assert.rejects(
    () => service.sendInput(
      { sessionId: child1.sessionId, requestId: 'send-1', text: 'Different content' },
      makeExec(caller),
    ),
    (err) => err.code === 'request-conflict',
  );

  // Retry with same requestId but different target -> conflict
  await assert.rejects(
    () => service.sendInput(
      { sessionId: child2.sessionId, requestId: 'send-1', text: 'Hello world!' },
      makeExec(caller),
    ),
    (err) => err.code === 'request-conflict',
  );
});

test('5. concurrent sendInput serializes and does not duplicate followup', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const caller = createMockAgent({ id: 'caller-conc', cwd: '/work/conc' });

  const child = await service.createSession({ requestId: 'req-conc-c' }, makeExec(caller));
  const targetAgent = ctx.agents.get(child.sessionId);

  // Fire two concurrent sends with identical (caller, target, requestId, text)
  const [resA, resB] = await Promise.all([
    service.sendInput({ sessionId: child.sessionId, requestId: 'send-conc-1', text: 'Concurrent' }, makeExec(caller)),
    service.sendInput({ sessionId: child.sessionId, requestId: 'send-conc-1', text: 'Concurrent' }, makeExec(caller)),
  ]);

  assert.equal(resA.receiptId, resB.receiptId);
  assert.equal(targetAgent.followups.length, 1);
});

test('concurrent conflicting request payloads or targets cannot share a receipt', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const exec = makeExec(createMockAgent({ id: 'creator' }));
  const a = await service.createSession({ requestId: 'child-a' }, exec);
  const b = await service.createSession({ requestId: 'child-b' }, exec);
  const accepted = service.sendInput({ sessionId: a.sessionId, requestId: 'shared-send', text: 'first' }, exec);
  const rejectedPayload = service.sendInput({ sessionId: a.sessionId, requestId: 'shared-send', text: 'second' }, exec);
  const rejectedTarget = service.sendInput({ sessionId: b.sessionId, requestId: 'shared-send', text: 'first' }, exec);
  const [receipt, payload, target] = await Promise.all([
    accepted,
    rejectedPayload.then(() => null, (error) => error),
    rejectedTarget.then(() => null, (error) => error),
  ]);
  assert.equal(payload?.code, 'request-conflict');
  assert.equal(target?.code, 'request-conflict');
  assert.equal(ctx.agents.get(a.sessionId).followups.length, 1);
  assert.equal(ctx.agents.get(b.sessionId).followups.length, 0);
  assert.equal((await service.queryReceipt({ receiptId: receipt.receiptId }, exec)).status, 'queued');
});


test('6. distinct request ID independent', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const caller = createMockAgent({ id: 'caller-1', cwd: '/work/c1' });

  const child = await service.createSession({ requestId: 'req-create-2' }, makeExec(caller));
  const targetAgent = ctx.agents.get(child.sessionId);

  const receiptA = await service.sendInput(
    { sessionId: child.sessionId, requestId: 'req-a', text: 'First payload' },
    makeExec(caller),
  );
  const receiptB = await service.sendInput(
    { sessionId: child.sessionId, requestId: 'req-b', text: 'Second payload' },
    makeExec(caller),
  );

  assert.notEqual(receiptA.receiptId, receiptB.receiptId);
  assert.equal(targetAgent.followups.length, 2);
});

test('trusted Host bot, webhook and scheduler share durable user-role delivery without human provenance', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const caller = createMockAgent({ id: 'creator' });
  const { sessionId } = await service.createSession({ requestId: 'target' }, makeExec(caller));
  const target = ctx.agents.get(sessionId);
  for (const kind of ['bot', 'webhook', 'scheduler']) {
    const input = {
      sessionId,
      requestId: `request-${kind}`,
      text: `input from ${kind}`,
      source: { kind, id: `producer-${kind}`, eventId: `event-${kind}` },
    };
    const accepted = await service.sendFromHost(input);
    assert.equal(accepted.status, 'queued');
    assert.equal((await service.sendFromHost(input)).receiptId, accepted.receiptId);
    const received = target.followups.at(-1);
    assert.equal(received.role, 'user');
    assert.notEqual(received.source.kind, 'user');
    assert.equal(received.source.initiatorKind, kind);
    assert.equal(received.source.originId, `producer-${kind}`);
    assert.equal(received.source.eventId, `event-${kind}`);
    assert.equal((await service.queryFromHost({ receiptId: accepted.receiptId, source: input.source })).status, 'queued');
    await assert.rejects(
      () => service.queryFromHost({
        receiptId: accepted.receiptId,
        source: { ...input.source, id: 'other-producer' },
      }),
      (error) => error.code === 'permission-denied',
    );
  }
  assert.equal(target.followups.length, 3);
  assert.throws(
    () => service.sendFromHost({
      sessionId, requestId: 'invalid-source', text: 'no event',
      source: { kind: 'webhook', id: 'producer' },
    }),
    (error) => error.code === 'bad-request',
  );
});

test('7. forged context IDs rejected', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const legitCaller = createMockAgent({ id: 'caller-legit', cwd: '/work/legit' });

  await assert.rejects(
    () => service.createSession({ requestId: 'r1' }, {}),
    (err) => err.code === 'unauthorized',
  );
  await assert.rejects(
    () => service.createSession({ requestId: 'r1' }, { agent: { session: { header: { id: '' } } } }),
    (err) => err.code === 'unauthorized',
  );
  await assert.rejects(
    () => service.createSession({ requestId: 'r1' }, { agent: { session: { header: { id: 12345 } } } }),
    (err) => err.code === 'unauthorized',
  );

  await assert.rejects(
    () => service.sendInput({ sessionId: 'target', requestId: 'r1', text: 'msg' }, {}),
    (err) => err.code === 'unauthorized',
  );

  await assert.rejects(
    () => service.sendInput({ sessionId: 'unknown-target', requestId: 'r1', text: 'msg' }, makeExec(legitCaller)),
    (err) => err.code === 'permission-denied',
  );

  await assert.rejects(
    () => service.queryReceipt({ receiptId: 'receipt-does-not-exist' }, makeExec(legitCaller)),
    (err) => err.code === 'unknown-receipt',
  );
});

test('8. exact group-thread allow while other chat/bot and sibling threads denied', async () => {
  const contexts = {
    'group-alpha': { botId: 'feishu-bot-1', chatId: 'oc_group_1' },
    'thread-alpha': { botId: 'feishu-bot-1', chatId: 'oc_group_1', threadId: 'omt_1', rootMessageId: 'om_root_1' },
    'thread-alpha-sibling': { botId: 'feishu-bot-1', chatId: 'oc_group_1', threadId: 'omt_2', rootMessageId: 'om_root_2' },
    'thread-other-chat': { botId: 'feishu-bot-1', chatId: 'oc_group_2', threadId: 'omt_3' },
    'thread-other-bot': { botId: 'feishu-bot-2', chatId: 'oc_group_1', threadId: 'omt_4' },
  };

  const deliveryService = {
    conversationContextForSession: async (id) => contexts[id] || null,
  };

  const agents = new Map([
    ['group-alpha', createMockAgent({ id: 'group-alpha', cwd: '/work/g' })],
    ['thread-alpha', createMockAgent({ id: 'thread-alpha', cwd: '/work/t1' })],
    ['thread-alpha-sibling', createMockAgent({ id: 'thread-alpha-sibling', cwd: '/work/t2' })],
    ['thread-other-chat', createMockAgent({ id: 'thread-other-chat', cwd: '/work/t3' })],
    ['thread-other-bot', createMockAgent({ id: 'thread-other-bot', cwd: '/work/t4' })],
  ]);

  const ctx = createMockCtx({ agents });
  const service = createLocalSessionService(ctx, { deliveryService, stateFile: ':memory:' });
  const groupCaller = agents.get('group-alpha');
  const threadCaller = agents.get('thread-alpha');

  // Exact group <-> thread: allowed
  const receiptFromGroup = await service.sendInput(
    { sessionId: 'thread-alpha', requestId: 'req-t1', text: 'Group to thread' },
    makeExec(groupCaller),
  );
  assert.equal(receiptFromGroup.status, 'queued');

  // Thread <-> group: allowed
  const receiptFromThread = await service.sendInput(
    { sessionId: 'group-alpha', requestId: 'req-t-back', text: 'Thread to group' },
    makeExec(threadCaller),
  );
  assert.equal(receiptFromThread.status, 'queued');

  // Sibling threads (thread-alpha <-> thread-alpha-sibling in SAME group): DENIED!
  await assert.rejects(
    () => service.sendInput(
      { sessionId: 'thread-alpha-sibling', requestId: 'req-sibling', text: 'Sibling thread' },
      makeExec(threadCaller),
    ),
    (err) => err.code === 'permission-denied',
  );

  // Cross-chat: denied
  await assert.rejects(
    () => service.sendInput(
      { sessionId: 'thread-other-chat', requestId: 'req-t2', text: 'Cross chat' },
      makeExec(groupCaller),
    ),
    (err) => err.code === 'permission-denied',
  );

  // Cross-bot: denied
  await assert.rejects(
    () => service.sendInput(
      { sessionId: 'thread-other-bot', requestId: 'req-t3', text: 'Cross bot' },
      makeExec(groupCaller),
    ),
    (err) => err.code === 'permission-denied',
  );
});

test('a child rebound to another Feishu group loses its persisted creator grant', async () => {
  const contexts = new Map();
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, {
    stateFile: ':memory:',
    deliveryService: { conversationContextForSession: async (id) => contexts.get(id) ?? null },
  });
  const caller = createMockAgent({ id: 'group-original' });
  const child = await service.createSession({ requestId: 'create-child' }, makeExec(caller));
  contexts.set('group-original', { botId: 'bot-a', chatId: 'chat-a' });
  contexts.set(child.sessionId, { botId: 'bot-a', chatId: 'chat-b', threadId: 'thread-b' });
  await assert.rejects(
    () => service.sendInput({ sessionId: child.sessionId, requestId: 'send-child', text: 'secret' }, makeExec(caller)),
    (error) => error.code === 'permission-denied',
  );
  assert.equal(ctx.agents.get(child.sessionId).followups.length, 0);
});

test('a missing target does not burn the request ID before durable reservation', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const caller = createMockAgent({ id: 'creator' });
  const child = await service.createSession({ requestId: 'child' }, makeExec(caller));
  const agent = ctx.agents.get(child.sessionId);
  ctx.agents.delete(child.sessionId);
  const input = { sessionId: child.sessionId, requestId: 'missing-then-present', text: 'run once' };
  await assert.rejects(() => service.sendInput(input, makeExec(caller)), (error) => error.code === 'unknown-session');
  ctx.agents.set(child.sessionId, agent);
  const receipt = await service.sendInput(input, makeExec(caller));
  assert.equal(receipt.status, 'queued');
  assert.equal(agent.followups.length, 1);
});

test('9. ambiguous flush unknown; never auto replay', async () => {
  const ctx = createMockCtx({ flushed: false });
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const caller = createMockAgent({ id: 'caller-1', cwd: '/work/c1' });

  const child = await service.createSession({ requestId: 'req-child' }, makeExec(caller));
  const targetAgent = ctx.agents.get(child.sessionId);

  const receipt = await service.sendInput(
    { sessionId: child.sessionId, requestId: 'send-unflushed', text: 'Flush will return false' },
    makeExec(caller),
  );

  assert.equal(receipt.status, 'unknown');
  assert.equal(targetAgent.followups.length, 1);

  // Querying this receipt preserves 'unknown' because inbox splice is not present in events yet
  // Remove event from targetAgent to simulate uncommitted event
  targetAgent.session.events.length = 0;
  const queryResult = await service.queryReceipt({ receiptId: receipt.receiptId }, makeExec(caller));
  assert.equal(queryResult.status, 'unknown');

  // Retrying send does NOT auto replay followup
  const retryReceipt = await service.sendInput(
    { sessionId: child.sessionId, requestId: 'send-unflushed', text: 'Flush will return false' },
    makeExec(caller),
  );
  assert.equal(retryReceipt.status, 'unknown');
  assert.equal(targetAgent.followups.length, 1);
});

test('a failed followup remains failed when its receipt is queried', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });
  const exec = makeExec(createMockAgent({ id: 'creator' }));
  const child = await service.createSession({ requestId: 'child' }, exec);
  const agent = ctx.agents.get(child.sessionId);
  agent.followup = () => { throw new Error('inbox unavailable'); };
  await assert.rejects(
    () => service.sendInput({ sessionId: child.sessionId, requestId: 'failed-followup', text: 'run' }, exec),
    /inbox unavailable/,
  );
  const [receiptId] = Object.keys((await service.getState()).receipts);
  const queried = await service.queryReceipt({ receiptId }, exec);
  assert.equal(queried.status, 'failed');
});

test('10. completed vs accepted and reply status; does not swallow provider query errors', async () => {
  let shouldThrowProviderError = false;
  const replyStatuses = new Map();
  const deliveryService = {
    replyStatusForReceipt: async (receiptId) => {
      if (shouldThrowProviderError) {
        throw new Error('Provider downstream unreachable');
      }
      return replyStatuses.get(receiptId);
    },
  };

  const ctx = createMockCtx({ flushed: true });
  const service = createLocalSessionService(ctx, { deliveryService, stateFile: ':memory:' });
  const caller = createMockAgent({ id: 'caller-1', cwd: '/work/c1' });

  const child = await service.createSession({ requestId: 'req-progress' }, makeExec(caller));
  const targetAgent = ctx.agents.get(child.sessionId);

  // 1. Admission
  const receipt = await service.sendInput(
    { sessionId: child.sessionId, requestId: 'send-p1', text: 'Run this turn' },
    makeExec(caller),
  );
  assert.equal(receipt.status, 'queued');

  // Querying immediately: queued
  const q1 = await service.queryReceipt({ receiptId: receipt.receiptId }, makeExec(caller));
  assert.equal(q1.status, 'queued');

  // 2. Turn starts running
  targetAgent.session.append('turn/start', { turn: 5 });
  targetAgent.session.append('user/message', { source: { receiptId: receipt.receiptId } });

  const q2 = await service.queryReceipt({ receiptId: receipt.receiptId }, makeExec(caller));
  assert.equal(q2.status, 'running');

  // 3. Turn completes
  targetAgent.session.append('turn/end', { turn: 5, reason: { kind: 'completed' } });
  replyStatuses.set(receipt.receiptId, { delivered: true, replyMessageId: 'om_reply_777' });

  const q3 = await service.queryReceipt({ receiptId: receipt.receiptId }, makeExec(caller));
  assert.equal(q3.status, 'completed');
  assert.equal(q3.turnId, 5);
  assert.deepEqual(q3.replyStatus, { delivered: true, replyMessageId: 'om_reply_777' });

  // 4. Provider query errors are NOT swallowed
  shouldThrowProviderError = true;
  await assert.rejects(
    () => service.queryReceipt({ receiptId: receipt.receiptId }, makeExec(caller)),
    (err) => err.message === 'Provider downstream unreachable',
  );
});

test('11. sender/target receipt query only; third-party sessions denied', async () => {
  const ctx = createMockCtx();
  const service = createLocalSessionService(ctx, { stateFile: ':memory:' });

  const sender = createMockAgent({ id: 'sender-session', cwd: '/work/s' });
  const target = createMockAgent({ id: 'target-session', cwd: '/work/t' });
  const thirdParty = createMockAgent({ id: 'third-party', cwd: '/work/p' });

  ctx.agents.set(sender.id, sender);
  ctx.agents.set(target.id, target);
  ctx.agents.set(thirdParty.id, thirdParty);

  // Sender creates target (creator-child link)
  const child = await service.createSession({ requestId: 'r-child' }, makeExec(sender));
  const receipt = await service.sendInput(
    { sessionId: child.sessionId, requestId: 'r-send', text: 'Privileged message' },
    makeExec(sender),
  );

  // Sender can query
  const qSender = await service.queryReceipt({ receiptId: receipt.receiptId }, makeExec(sender));
  assert.equal(qSender.receiptId, receipt.receiptId);

  // Target can query
  const targetAgent = ctx.agents.get(child.sessionId);
  const qTarget = await service.queryReceipt({ receiptId: receipt.receiptId }, makeExec(targetAgent));
  assert.equal(qTarget.receiptId, receipt.receiptId);

  // Third party cannot query (permission-denied, no transitive grants)
  await assert.rejects(
    () => service.queryReceipt({ receiptId: receipt.receiptId }, makeExec(thirdParty)),
    (err) => err.code === 'permission-denied',
  );
});

test('12. durable state persistence, version validation, and default path resolution', async () => {
  // Test default path resolution
  const expectedDefault = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'integrations', 'dsh-im', 'session-tools.json');
  assert.equal(resolveDefaultStateFile(), expectedDefault);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-session-tools-state-'));
  const statePath = join(dir, 'state.json');

  try {
    const ctx = createMockCtx();
    const caller = createMockAgent({ id: 'caller-durable', cwd: '/work/dur' });

    // Instance 1
    const service1 = createLocalSessionService(ctx, { stateFile: statePath });
    const child = await service1.createSession({ requestId: 'req-dur-1' }, makeExec(caller));
    const receipt = await service1.sendInput(
      { sessionId: child.sessionId, requestId: 'send-dur-1', text: 'Saved to disk' },
      makeExec(caller),
    );
    await service1.close();

    // Verify version in state file
    const content = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(content.version, 1);
    assert.ok(content.sessions[child.sessionId]);
    assert.ok(content.receipts[receipt.receiptId]);

    // Instance 2 (simulating restart)
    const service2 = createLocalSessionService(ctx, { stateFile: statePath });
    const queried = await service2.queryReceipt({ receiptId: receipt.receiptId }, makeExec(caller));
    assert.equal(queried.receiptId, receipt.receiptId);
    assert.equal(queried.targetSessionId, child.sessionId);

    // Test corrupted version rejection
    await writeFile(statePath, JSON.stringify({ version: 2, sessions: {} }), 'utf8');
    const serviceCorrupted = createLocalSessionService(ctx, { stateFile: statePath });
    await assert.rejects(
      () => serviceCorrupted.createSession({ requestId: 'r-fail' }, makeExec(caller)),
      (err) => err.code === 'state-version-mismatch',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('13. installLocalSessionTools registers tools and executes properly', async () => {
  const registered = new Map();
  const ctx = {
    tools: {
      register: (tool) => {
        registered.set(tool.name, tool);
      },
    },
  };

  const service = {
    createSession: async (args) => ({ sessionId: 'created', ...args }),
    sendInput: async (args) => ({ receiptId: 'sent', ...args }),
    queryReceipt: async (args) => ({ status: 'completed', ...args }),
  };

  assert.equal(installLocalSessionTools(ctx, service), true);
  assert.deepEqual(Array.from(registered.keys()).sort(), [...SESSION_TOOL_NAMES].sort());

  const createTool = registered.get('dsh_im_session_create');
  assert.equal(createTool.parameters.required.includes('requestId'), true);
  assert.equal(createTool.parameters.properties.cwd, undefined);
  assert.equal(createTool.parameters.properties.sessionId, undefined);

  const sendTool = registered.get('dsh_im_session_send_input');
  assert.deepEqual(sendTool.parameters.required.sort(), ['requestId', 'sessionId', 'text'].sort());

  const queryTool = registered.get('dsh_im_session_query');
  assert.deepEqual(queryTool.parameters.required, ['receiptId']);

  const exec = makeExec(createMockAgent({ id: 'c1', cwd: '/work' }));
  const createOut = await createTool.execute({ requestId: 'r1' }, exec);
  assert.equal(createOut.sessionId, 'created');

  const sendOut = await sendTool.execute({ sessionId: 's1', requestId: 'r1', text: 'hi' }, exec);
  assert.equal(sendOut.receiptId, 'sent');

  const queryOut = await queryTool.execute({ receiptId: 'rec-1' }, exec);
  assert.equal(queryOut.status, 'completed');
});
