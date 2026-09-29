import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const jsonOutput = Object.freeze({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
});

export const SESSION_TOOL_NAMES = Object.freeze([
  'dsh_im_session_create',
  'dsh_im_session_send_input',
  'dsh_im_session_query',
]);
const trustedHostSource = Symbol('dsh-im trusted Host source');

function checkedHostSource(source) {
  if (!source || !['bot', 'webhook', 'scheduler'].includes(source.kind)
    || typeof source.id !== 'string' || !source.id.trim()
    || typeof source.eventId !== 'string' || !source.eventId.trim()) {
    throw toolError('bad-request', 'A trusted bot/webhook/scheduler source needs an id and eventId');
  }
  return Object.freeze({
    kind: source.kind,
    id: source.id.trim(),
    eventId: source.eventId.trim(),
    ...(typeof source.sessionId === 'string' && source.sessionId.trim()
      ? { sessionId: source.sessionId.trim() } : {}),
  });
}

function toolError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

export function resolveDefaultStateFile() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'integrations', 'dsh-im', 'session-tools.json');
}

function resolveCallerSessionId(exec) {
  const headerId = exec?.agent?.session?.header?.id;
  if (typeof headerId === 'string' && headerId.trim()) {
    return headerId.trim();
  }
  return null;
}

function resolveCallerCwdAndPreset(exec) {
  const session = exec?.agent?.session;
  const cwd = session?.header?.cwd;
  if (typeof cwd !== 'string' || !cwd.trim()) {
    throw toolError('unauthorized', 'Authoritative caller cwd is required in exec.agent.session.header.cwd');
  }
  const agentPreset = session?.header?.agentPreset;
  return { cwd: cwd.trim(), agentPreset: typeof agentPreset === 'string' ? agentPreset : undefined };
}

function createEmptyState() {
  return {
    version: 1,
    sessions: {},
    reservations: {},
    receipts: {},
    deliveries: {},
    callerRequests: {},
  };
}

function validateAndNormalizeState(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw toolError('state-corrupted', 'Invalid session tools state file format');
  }
  if (parsed.version !== 1) {
    throw toolError('state-version-mismatch', `Unsupported state version: ${parsed.version}`);
  }
  return {
    version: 1,
    sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    reservations: parsed.reservations && typeof parsed.reservations === 'object' ? parsed.reservations : {},
    receipts: parsed.receipts && typeof parsed.receipts === 'object' ? parsed.receipts : {},
    deliveries: parsed.deliveries && typeof parsed.deliveries === 'object' ? parsed.deliveries : {},
    callerRequests: parsed.callerRequests && typeof parsed.callerRequests === 'object' ? parsed.callerRequests : {},
  };
}

export function createLocalSessionService(ctx, options = {}) {
  const deliveryService = options?.deliveryService;
  const stateFile = options?.stateFile !== undefined
    ? options.stateFile
    : (process.env.DSH_IM_LOCAL_SESSION_STATE_FILE || resolveDefaultStateFile());

  let state = null;
  let loadPromise = null;
  let writeQueue = Promise.resolve();
  const inFlightDispatches = new Map();
  const inFlightCreates = new Map();

  async function ensureLoaded() {
    if (state) return state;
    if (!loadPromise) {
      loadPromise = (async () => {
        if (!stateFile || stateFile === ':memory:') {
          state = createEmptyState();
          return state;
        }
        try {
          const raw = await readFile(stateFile, 'utf8');
          const parsed = JSON.parse(raw);
          state = validateAndNormalizeState(parsed);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          state = createEmptyState();
          await persist();
        }
        return state;
      })();
    }
    return loadPromise;
  }

  async function persist() {
    if (!stateFile || stateFile === ':memory:' || !state) return;
    const snapshot = JSON.stringify(state, null, 2) + '\n';
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
      const temporary = `${stateFile}.tmp.${randomUUID()}`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, stateFile);
    });
    await writeQueue;
  }

  async function isAuthorized(callerSessionId, targetSessionId, loadedState) {
    if (!callerSessionId || !targetSessionId) return false;
    // A persisted creator link cannot override a later Feishu rebind to another group.
    if (typeof deliveryService?.conversationContextForSession === 'function') {
      const [callerContext, targetContext] = await Promise.all([
        deliveryService.conversationContextForSession(callerSessionId),
        deliveryService.conversationContextForSession(targetSessionId),
      ]);
      if (callerContext && targetContext
        && (callerContext.botId !== targetContext.botId
          || callerContext.chatId !== targetContext.chatId)) return false;
    }
    if (callerSessionId === targetSessionId) return true;

    // 1. Creator-child link check
    const targetRecord = loadedState.sessions[targetSessionId];
    if (targetRecord?.creatorSessionId === callerSessionId) {
      return true;
    }
    const callerRecord = loadedState.sessions[callerSessionId];
    if (callerRecord?.creatorSessionId === targetSessionId) {
      return true;
    }

    // 2. Exact Feishu group <-> thread mutual grants
    if (typeof deliveryService?.conversationContextForSession === 'function') {
      const callerCtx = await deliveryService.conversationContextForSession(callerSessionId);
      const targetCtx = await deliveryService.conversationContextForSession(targetSessionId);

      if (callerCtx && targetCtx) {
        const sameBot = Boolean(callerCtx.botId && callerCtx.botId === targetCtx.botId);
        const sameChat = Boolean(callerCtx.chatId && callerCtx.chatId === targetCtx.chatId);

        if (sameBot && sameChat) {
          const callerIsThread = Boolean(callerCtx.threadId);
          const targetIsThread = Boolean(targetCtx.threadId);

          // Deny sibling threads: thread <-> other thread is forbidden
          if (callerIsThread && targetIsThread) {
            return false;
          }

          // Only exact group <-> thread pair
          if ((!callerIsThread && targetIsThread) || (callerIsThread && !targetIsThread)) {
            return true;
          }
        }
        return false;
      }
    }

    return false;
  }

  async function createSessionOnce(args, exec) {
    const callerSessionId = resolveCallerSessionId(exec);
    if (!callerSessionId) {
      throw toolError('unauthorized', 'Caller session identity is required from exec.agent.session.header.id');
    }
    const requestId = args?.requestId;
    if (typeof requestId !== 'string' || !requestId.trim()) {
      throw toolError('bad-request', 'requestId is required');
    }

    const loadedState = await ensureLoaded();
    const reservationKey = `${callerSessionId}:${requestId.trim()}`;
    const requestedThreadId = args?.threadId ?? null;
    const requestedRootMessageId = args?.rootMessageId ?? null;

    if (loadedState.reservations[reservationKey]) {
      const existing = loadedState.reservations[reservationKey];
      const existingSessionId = typeof existing === 'string' ? existing : existing.sessionId;
      const existingThreadId = typeof existing === 'object'
        ? (existing.threadId ?? null)
        : (loadedState.sessions[existingSessionId]?.threadId ?? null);
      const existingRootId = typeof existing === 'object'
        ? (existing.rootMessageId ?? null)
        : (loadedState.sessions[existingSessionId]?.rootMessageId ?? null);

      if (existingThreadId !== requestedThreadId || existingRootId !== requestedRootMessageId) {
        throw toolError('request-conflict', 'Request ID already used with different threadId or rootMessageId');
      }

      const existingSession = loadedState.sessions[existingSessionId];
      return {
        sessionId: existingSessionId,
        created: false,
        ...(existingSession?.cwd ? { cwd: existingSession.cwd } : {}),
        ...(existingSession?.agentPreset ? { agentPreset: existingSession.agentPreset } : {}),
        ...(existingSession?.threadId ? { threadId: existingSession.threadId } : {}),
        ...(existingSession?.rootMessageId ? { rootMessageId: existingSession.rootMessageId } : {}),
        ...(existingSession?.botId ? { botId: existingSession.botId } : {}),
        ...(existingSession?.chatId ? { chatId: existingSession.chatId } : {}),
      };
    }

    const hasThreadTarget = args?.threadId !== undefined || args?.rootMessageId !== undefined;
    if (hasThreadTarget) {
      if (typeof deliveryService?.ensureFeishuThreadSession !== 'function') {
        throw toolError('provider-unavailable', 'Feishu thread session provider is unavailable');
      }
      const controller = ctx?.sessionController ?? (typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined);
      const threadSession = await deliveryService.ensureFeishuThreadSession({
        senderSessionId: callerSessionId,
        threadId: args.threadId,
        rootMessageId: args.rootMessageId,
        requestId: requestId.trim(),
        sessionController: controller,
      });
      if (!threadSession?.sessionId) {
        throw toolError('thread-session-failed', 'Failed to ensure Feishu thread session');
      }
      const sessionId = threadSession.sessionId;
      loadedState.reservations[reservationKey] = {
        sessionId,
        threadId: requestedThreadId,
        rootMessageId: requestedRootMessageId,
      };
      loadedState.sessions[sessionId] = {
        sessionId,
        creatorSessionId: callerSessionId,
        requestId: requestId.trim(),
        threadId: threadSession.threadId ?? args.threadId,
        rootMessageId: threadSession.rootMessageId ?? args.rootMessageId,
        botId: threadSession.botId,
        chatId: threadSession.chatId,
        createdAt: Date.now(),
      };
      await persist();
      return {
        sessionId,
        created: true,
        threadId: threadSession.threadId,
        rootMessageId: threadSession.rootMessageId,
        botId: threadSession.botId,
        chatId: threadSession.chatId,
      };
    }

    const { cwd, agentPreset } = resolveCallerCwdAndPreset(exec);
    const hash = createHash('sha256')
      .update(`${callerSessionId}:${requestId.trim()}`)
      .digest('hex')
      .slice(0, 16);
    const deterministicSessionId = `session-local-${hash}`;

    const controller = ctx?.sessionController ?? (typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined);
    if (!controller || typeof controller.create !== 'function') {
      throw toolError('host-unavailable', 'Host session controller is unavailable');
    }

    const created = await controller.create({
      sessionId: deterministicSessionId,
      cwd,
      ...(agentPreset ? { agentPreset } : {}),
    });

    const sessionId = created?.sessionId ?? deterministicSessionId;
    loadedState.reservations[reservationKey] = {
      sessionId,
      threadId: null,
      rootMessageId: null,
    };
    loadedState.sessions[sessionId] = {
      sessionId,
      creatorSessionId: callerSessionId,
      requestId: requestId.trim(),
      cwd,
      agentPreset,
      createdAt: Date.now(),
    };
    await persist();

    return {
      sessionId,
      created: true,
      cwd,
      ...(agentPreset ? { agentPreset } : {}),
    };
  }
  async function createSession(args, exec) {
    const callerSessionId = resolveCallerSessionId(exec);
    const requestId = args?.requestId;
    if (!callerSessionId || typeof requestId !== 'string' || !requestId.trim()) {
      return createSessionOnce(args, exec);
    }
    const key = JSON.stringify([callerSessionId, requestId.trim()]);
    const threadId = args?.threadId ?? null;
    const rootMessageId = args?.rootMessageId ?? null;
    const pending = inFlightCreates.get(key);
    if (pending) {
      if (pending.threadId !== threadId || pending.rootMessageId !== rootMessageId) {
        throw toolError('request-conflict', 'Request ID already used with different threadId or rootMessageId');
      }
      return { ...await pending.promise, created: false };
    }
    const promise = createSessionOnce(args, exec);
    inFlightCreates.set(key, { threadId, rootMessageId, promise });
    try {
      return await promise;
    } finally {
      inFlightCreates.delete(key);
    }
  }


  async function sendInput(args, exec) {
    const hostSource = exec?.[trustedHostSource] ?? null;
    const callerSessionId = hostSource?.sessionId ?? resolveCallerSessionId(exec);
    if (!hostSource && !callerSessionId) {
      throw toolError('unauthorized', 'Caller session identity is required from exec.agent.session.header.id');
    }
    const targetSessionId = args?.sessionId;
    if (typeof targetSessionId !== 'string' || !targetSessionId.trim()) {
      throw toolError('bad-request', 'sessionId is required');
    }
    const requestId = args?.requestId;
    if (typeof requestId !== 'string' || !requestId.trim()) {
      throw toolError('bad-request', 'requestId is required');
    }
    const text = args?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw toolError('bad-request', 'text is required and must not be empty');
    }

    const loadedState = await ensureLoaded();

    const authorized = hostSource || await isAuthorized(callerSessionId, targetSessionId.trim(), loadedState);
    if (!authorized) {
      throw toolError('permission-denied', `Caller session ${callerSessionId} is not authorized to access session ${targetSessionId}`);
    }

    const callerKey = hostSource
      ? JSON.stringify(['host', hostSource.kind, hostSource.id])
      : JSON.stringify(['agent', callerSessionId]);
    const deliveryKey = JSON.stringify([callerKey, targetSessionId.trim(), requestId.trim()]);
    const callerReqKey = JSON.stringify([callerKey, requestId.trim()]);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({
        callerKey,
        targetSessionId: targetSessionId.trim(),
        requestId: requestId.trim(),
        text,
        eventId: hostSource?.eventId ?? null,
      }))
      .digest('hex');

    // A request ID belongs to one caller and one payload even while its first
    // target resolves. Locking by target allows conflicting concurrent requests.
    const inFlight = inFlightDispatches.get(callerReqKey);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        throw toolError('request-conflict', 'Request ID already used with different target or content');
      }
      return inFlight.promise;
    }

    const dispatchPromise = (async () => {
      // 1. Check caller requests conflict across targets/payloads
      const existingCallerReq = loadedState.callerRequests[callerReqKey];
      if (existingCallerReq) {
        if (existingCallerReq.targetSessionId !== targetSessionId.trim() || existingCallerReq.fingerprint !== fingerprint) {
          throw toolError('request-conflict', 'Request ID already used with different target or content');
        }
        const existingReceipt = loadedState.receipts[existingCallerReq.receiptId];
        if (existingReceipt) {
          return existingReceipt;
        }
      }

      // 2. Check deliveryKey existence
      if (loadedState.deliveries[deliveryKey]) {
        const existingReceiptId = loadedState.deliveries[deliveryKey];
        const existingReceipt = loadedState.receipts[existingReceiptId];
        if (existingReceipt) {
          if (existingReceipt.fingerprint === fingerprint) {
            return existingReceipt;
          }
          throw toolError('request-conflict', 'Request ID already used with different content');
        }
      }

      // Resolve before reserving: a definitely missing target must not consume the key.
      const controller = ctx?.sessionController ?? (typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined);
      if (!controller || typeof controller.resolveAgent !== 'function') {
        throw toolError('host-unavailable', 'Host session controller is unavailable');
      }
      const resolved = await controller.resolveAgent(targetSessionId.trim());
      if (resolved?.error || !resolved?.agent) {
        throw toolError('unknown-session', resolved?.error?.message ?? `Session ${targetSessionId} could not be resolved`);
      }
      const agent = resolved.agent;
      if (typeof agent?.followup !== 'function' || !agent?.session) {
        throw toolError('invalid-session', `Target session ${targetSessionId} is not an agent session`);
      }

      // 3. Durable reservation with 'dispatching' BEFORE followup
      const receiptId = `receipt-${randomUUID()}`;
      const receipt = {
        receiptId,
        requestId: requestId.trim(),
        sourceSessionId: callerSessionId ?? null,
        ...(hostSource ? { originKind: hostSource.kind, originId: hostSource.id, eventId: hostSource.eventId } : {}),
        targetSessionId: targetSessionId.trim(),
        fingerprint,
        status: 'dispatching',
        createdAt: Date.now(),
      };

      loadedState.deliveries[deliveryKey] = receiptId;
      loadedState.callerRequests[callerReqKey] = {
        targetSessionId: targetSessionId.trim(),
        receiptId,
        fingerprint,
      };
      loadedState.receipts[receiptId] = receipt;
      await persist();


      const message = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: Object.freeze([{ type: 'text', text }]),
        source: Object.freeze({
          kind: 'plugin:dsh-im-session-tools',
          initiatorKind: hostSource?.kind ?? 'agent',
          ...(hostSource ? { originId: hostSource.id, eventId: hostSource.eventId } : {}),
          ...(callerSessionId ? { sourceSessionId: callerSessionId } : {}),
          requestId: requestId.trim(),
          receiptId,
        }),
      });

      try {
        agent.followup(message);
      } catch (err) {
        receipt.status = 'failed';
        receipt.error = err.message;
        await persist();
        throw err;
      }

      // 5. Durable flush bound to sessions service
      let flushed = false;
      try {
        const sessions = ctx?.sessions ?? (typeof ctx?.get === 'function' ? ctx.get('sessions') : undefined);
        if (typeof sessions?.flush === 'function') {
          flushed = (await sessions.flush(agent.session)) === true;
        }
      } catch {
        flushed = false;
      }

      receipt.status = flushed ? 'queued' : 'unknown';
      await persist();

      return receipt;
    })();

    inFlightDispatches.set(callerReqKey, { fingerprint, promise: dispatchPromise });
    try {
      return await dispatchPromise;
    } finally {
      inFlightDispatches.delete(callerReqKey);
    }
  }

  async function queryReceipt(args, exec) {
    const hostSource = exec?.[trustedHostSource] ?? null;
    const callerSessionId = hostSource?.sessionId ?? resolveCallerSessionId(exec);
    if (!hostSource && !callerSessionId) {
      throw toolError('unauthorized', 'Caller session identity is required from exec.agent.session.header.id');
    }
    const receiptId = args?.receiptId;
    if (typeof receiptId !== 'string' || !receiptId.trim()) {
      throw toolError('bad-request', 'receiptId is required');
    }

    const loadedState = await ensureLoaded();
    const receipt = loadedState.receipts[receiptId.trim()];
    if (!receipt) {
      throw toolError('unknown-receipt', `Receipt ${receiptId} not found`);
    }

    // A trusted Host producer sees only its own receipts; Agent tools remain session-scoped.
    if (hostSource
      ? receipt.originKind !== hostSource.kind || receipt.originId !== hostSource.id
      : callerSessionId !== receipt.sourceSessionId && callerSessionId !== receipt.targetSessionId) {
      throw toolError('permission-denied', `Caller is not authorized to query receipt ${receiptId}`);
    }

    let currentStatus = receipt.status;
    let turnId = null;
    let endReason = null;

    const controller = ctx?.sessionController ?? (typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined);
    if (controller && typeof controller.resolveAgent === 'function') {
      try {
        const resolved = await controller.resolveAgent(receipt.targetSessionId);
        if (resolved?.agent?.session) {
          const session = resolved.agent.session;
          const events = typeof session.snapshotEvents === 'function'
            ? session.snapshotEvents()
            : (Array.isArray(session.events) ? session.events : []);

          // Inspect inbox splice to distinguish queued vs unknown
          const admittedInInbox = events.some((e) =>
            e.type === 'agent/inbox/spliced' &&
            e.data?.inserted?.some((m) => m.source?.receiptId === receiptId.trim())
          );
          const admittedInMessage = events.some((e) =>
            e.type === 'user/message' &&
            e.data?.source?.receiptId === receiptId.trim()
          );

          if (!admittedInInbox && !admittedInMessage) {
            if (currentStatus !== 'failed') currentStatus = 'unknown';
          } else if (currentStatus !== 'failed') {
            if (currentStatus === 'dispatching' || currentStatus === 'unknown') {
              currentStatus = 'queued';
            }

            let activeTurn = null;
            let receiptTurn = null;

            for (const event of events) {
              if (event.type === 'turn/start') {
                activeTurn = event.data?.turn;
              }
              if (event.type === 'user/message' && event.data?.source?.receiptId === receiptId.trim()) {
                receiptTurn = activeTurn ?? event.data?.turn;
                currentStatus = 'running';
              }
              if (event.type === 'turn/end') {
                const endedTurn = event.data?.turn;
                if (receiptTurn !== null && endedTurn === receiptTurn) {
                  turnId = endedTurn;
                  const kind = event.data?.reason?.kind;
                  if (kind === 'completed') {
                    currentStatus = 'completed';
                  } else {
                    currentStatus = 'failed';
                  }
                  endReason = kind ?? 'ended';
                }
              }
            }
          }
        }
      } catch {
        // preserve currentStatus on resolution failure
      }
    }

    // Do NOT swallow provider query errors silently
    let replyStatus;
    if (typeof deliveryService?.replyStatusForReceipt === 'function') {
      replyStatus = await deliveryService.replyStatusForReceipt(receiptId.trim());
    }

    if (currentStatus !== receipt.status) {
      receipt.status = currentStatus;
      await persist();
    }

    return {
      receiptId: receipt.receiptId,
      requestId: receipt.requestId,
      sourceSessionId: receipt.sourceSessionId,
      targetSessionId: receipt.targetSessionId,
      status: currentStatus,
      ...(turnId !== null ? { turnId } : {}),
      ...(endReason !== null ? { endReason } : {}),
      ...(replyStatus !== undefined ? { replyStatus } : {}),
      createdAt: receipt.createdAt,
    };
  }


  // Same-process Cordis plugins are trusted Host code; never expose these methods over HTTP/RPC.
  // The producer authenticates its external event before declaring the source.
  function sendFromHost(args) {
    return sendInput(args, { [trustedHostSource]: checkedHostSource(args?.source) });
  }

  function queryFromHost(args) {
    return queryReceipt(args, { [trustedHostSource]: checkedHostSource(args?.source) });
  }
  return {
    createSession,
    sendInput,
    sendFromHost,
    queryFromHost,
    deliverInput: sendInput,
    queryReceipt,
    query: queryReceipt,
    isAuthorized: (callerSessionId, targetSessionId) => {
      if (!state) return false;
      return isAuthorized(callerSessionId, targetSessionId, state);
    },
    getState: async () => ensureLoaded(),
    close: async () => {
      await writeQueue;
    },
  };
}

export function installLocalSessionTools(ctx, service) {
  if (typeof ctx?.tools?.register !== 'function') return false;

  ctx.tools.register({
    name: 'dsh_im_session_create',
    description: 'Create or bind an independent local DSH Session or Feishu discussion thread session. Inherits caller workspace directory and preset; idempotent by caller and requestId.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requestId: {
          type: 'string',
          minLength: 1,
          description: 'Unique idempotency key for this create request.',
        },
        threadId: {
          type: 'string',
          description: 'Optional Feishu thread ID for thread session binding.',
        },
        rootMessageId: {
          type: 'string',
          description: 'Optional Feishu root message ID for thread session binding.',
        },
      },
      required: ['requestId'],
    },
    output: jsonOutput,
    async execute(args, exec) {
      return service.createSession(args, exec);
    },
  });

  ctx.tools.register({
    name: 'dsh_im_session_send_input',
    description: 'Deliver a non-human message to an authorized target session and request durable persistence. Returns an admission receipt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
          description: 'Target session ID to receive the input.',
        },
        requestId: {
          type: 'string',
          minLength: 1,
          description: 'Unique idempotency key for this delivery request.',
        },
        text: {
          type: 'string',
          minLength: 1,
          description: 'Input message text.',
        },
      },
      required: ['sessionId', 'requestId', 'text'],
    },
    output: jsonOutput,
    async execute(args, exec) {
      return service.sendInput(args, exec);
    },
  });

  ctx.tools.register({
    name: 'dsh_im_session_query',
    description: 'Query the execution progress and Feishu reply status of an admission receipt.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        receiptId: {
          type: 'string',
          minLength: 1,
          description: 'Admission receipt ID returned by dsh_im_session_send_input.',
        },
      },
      required: ['receiptId'],
    },
    output: jsonOutput,
    async execute(args, exec) {
      return service.queryReceipt(args, exec);
    },
  });

  return true;
}
