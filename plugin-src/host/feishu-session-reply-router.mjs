import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  AssistantTextAccumulator,
  textFromHarnessContent,
} from '../../src/channels/shared/harness-client.mjs';

export function resolveDefaultRouterStateFile() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'integrations', 'dsh-feishu', 'reply-router-state.json');
}

function sessionIdOf(session) {
  const value = session?.id ?? session?.sessionId ?? session?.header?.id ?? (typeof session === 'string' ? session : null);
  return typeof value === 'string' && value ? value : null;
}

function completedTurn(reason) {
  return (typeof reason === 'string' ? reason : reason?.kind) === 'completed';
}

function formatTurnError(reason, error) {
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof reason === 'string' && reason.trim()) {
    return `Turn ended: ${reason.trim()}`;
  }
  if (typeof reason?.message === 'string' && reason.message.trim()) {
    return reason.message.trim();
  }
  if (typeof reason?.kind === 'string' && reason.kind.trim()) {
    return `Turn ended: ${reason.kind.trim()}`;
  }
  return 'Turn ended unexpectedly';
}

export function createFeishuSessionReplyRouter({
  deliveryService,
  logger = console,
  stateFile = process.env.DSH_IM_FEISHU_ROUTER_STATE_FILE || resolveDefaultRouterStateFile(),
}) {
  if (!deliveryService || typeof deliveryService !== 'object') {
    throw new TypeError('deliveryService is required');
  }

  const activeTurns = new Map();
  const receiptStatuses = new Map();
  const deliveredReceipts = new Set();
  const tails = new Map();
  let closed = false;
  let writeQueue = Promise.resolve();
  let loaded = false;
  let loadPromise = null;

  const loadState = async () => {
    if (loaded) return;
    if (!loadPromise) {
      loadPromise = (async () => {
        if (stateFile && stateFile !== ':memory:') {
          try {
            const raw = await readFile(stateFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed?.version !== 1) throw new Error('Unsupported reply router state version');
            for (const [id, status] of Object.entries(parsed.receiptStatuses ?? {})) {
              receiptStatuses.set(id, status);
            }
            for (const id of parsed.deliveredReceipts ?? []) deliveredReceipts.add(id);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
        loaded = true;
      })();
    }
    await loadPromise;
  };

  const persistState = async () => {
    if (!stateFile || stateFile === ':memory:') return;
    const snapshot = JSON.stringify({
      version: 1,
      receiptStatuses: Object.fromEntries(receiptStatuses.entries()),
      deliveredReceipts: [...deliveredReceipts],
    }, null, 2) + '\n';

    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
      const temporary = `${stateFile}.tmp.${randomUUID()}`;
      await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, stateFile);
    }).catch((err) => {
      logger.warn?.('[feishu-reply-router] failed to persist stateFile:', err?.message ?? err);
    });
    await writeQueue;
  };

  const setReceiptStatus = async (receiptId, statusObj) => {
    receiptStatuses.set(receiptId, statusObj);
    await persistState();
  };

  const logFailure = (phase, receiptId, error) => {
    logger.warn?.(
      `[feishu-reply-router] ${phase} failure`
        + (receiptId ? ` (receipt: ${receiptId})` : '')
        + ` [${error?.code ?? error?.name ?? 'unknown-error'}]: ${error?.message ?? error}`,
    );
  };

  const extractPluginSource = (event) => {
    if (event.type === 'user/message') {
      const source = event.data?.source ?? event.source ?? event.data?.message?.source;
      if (source?.kind === 'plugin:dsh-im-session-tools'
        && typeof source.receiptId === 'string' && source.receiptId) {
        return {
          source,
          turn: Number.isSafeInteger(event.data?.turn) ? event.data.turn : null,
        };
      }
    }
    return null;
  };

  const processEvent = async (sessionId, event) => {
    if (closed || !event || typeof event !== 'object') return;
    if (!loaded) await loadState();

    const pluginTurn = extractPluginSource(event);
    if (pluginTurn) {
      const { source, turn } = pluginTurn;
      const receiptId = source.receiptId;

      // Startup / replay protection: do not restart an already delivered turn
      if (deliveredReceipts.has(receiptId)) return;

      const turnState = {
        receiptId,
        requestId: source.requestId ?? null,
        sourceSessionId: source.sourceSessionId ?? null,
        sessionId,
        turn,
        step: null,
        assistant: new AssistantTextAccumulator(),
      };

      const turnKey = turn !== null ? `${sessionId}:${turn}` : `${sessionId}:current`;
      activeTurns.set(turnKey, turnState);
      activeTurns.set(`${sessionId}:current`, turnState);

      if (!receiptStatuses.has(receiptId)) {
        await setReceiptStatus(receiptId, {
          status: 'running',
          receiptId,
          requestId: source.requestId ?? null,
          sessionId,
          startedAt: Date.now(),
        });
      }
      return;
    }

    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : null;
    const turnKey = turn !== null ? `${sessionId}:${turn}` : `${sessionId}:current`;
    const state = activeTurns.get(turnKey) ?? activeTurns.get(`${sessionId}:current`);
    if (!state) return;

    if (event.type === 'step/start') {
      if (event.data?.turn !== undefined && state.turn !== null && event.data.turn !== state.turn) return;
      state.step = Number.isSafeInteger(event.data?.step) ? event.data.step : null;
      return;
    }

    if (event.type === 'step/end') {
      if (event.data?.turn !== undefined && state.turn !== null && event.data.turn !== state.turn) return;
      if (event.data?.step === undefined || event.data.step === state.step) state.step = null;
      return;
    }

    if (event.type === 'assistant/chunk') {
      if (event.data?.turn !== undefined && state.turn !== null && event.data.turn !== state.turn) return;
      const chunk = event.data?.chunk;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        const step = Number.isSafeInteger(event.data?.step) ? event.data.step : state.step;
        state.assistant.appendDelta(step, chunk.index, chunk.text);
      }
      return;
    }

    if (event.type === 'assistant/message') {
      if (event.surfaceOp !== 'append'
        || event.data?.interrupted === true
        || (event.data?.turn !== undefined && state.turn !== null && event.data.turn !== state.turn)) return;
      const text = textFromHarnessContent(event.data?.message?.content);
      const step = Number.isSafeInteger(event.data?.step) ? event.data.step : state.step;
      state.assistant.setCanonical(step, text);
      return;
    }

    if (event.type === 'turn/end') {
      if (state.turn !== null && event.data?.turn !== undefined && event.data.turn !== state.turn) return;

      activeTurns.delete(turnKey);
      if (activeTurns.get(`${sessionId}:current`) === state) {
        activeTurns.delete(`${sessionId}:current`);
      }

      const receiptId = state.receiptId;
      if (deliveredReceipts.has(receiptId)) return;

      const reason = event.data?.reason;
      const isCompleted = completedTurn(reason);

      let context = null;
      try {
        context = await deliveryService.conversationContextForSession(sessionId);
      } catch (error) {
        logFailure('context resolution', receiptId, error);
      }

      if (!context?.botId || !context?.chatId || !context?.rootMessageId) {
        // Must never fall back to main group feed!
        await setReceiptStatus(receiptId, {
          status: 'failed',
          receiptId,
          error: 'Target session is missing verified rootMessageId; reply dropped to prevent main feed fallback',
          failedAt: Date.now(),
        });
        return;
      }

      const target = {
        kind: 'group',
        route: { chatId: context.chatId },
      };

      if (!isCompleted) {
        const errorText = formatTurnError(reason, event.data?.error);
        const report = `[Session Error] ${errorText}`;
        try {
          await deliveryService.send(
            context.botId,
            target,
            report,
            {
              replyToMessageId: context.rootMessageId,
              replyInThread: true,
              format: 'plain',
            },
          );
        } catch (sendError) {
          logFailure('error notice send', receiptId, sendError);
        }
        deliveredReceipts.add(receiptId);
        await setReceiptStatus(receiptId, {
          status: 'failed',
          receiptId,
          error: errorText,
          threadId: context.threadId,
          rootMessageId: context.rootMessageId,
          failedAt: Date.now(),
        });
        return;
      }

      const finalText = state.assistant.text;
      if (!finalText || !finalText.trim()) {
        deliveredReceipts.add(receiptId);
        await setReceiptStatus(receiptId, {
          status: 'completed_no_output',
          receiptId,
          threadId: context.threadId,
          rootMessageId: context.rootMessageId,
          completedAt: Date.now(),
        });
        return;
      }

      try {
        const sendResult = await deliveryService.send(
          context.botId,
          target,
          finalText,
          {
            replyToMessageId: context.rootMessageId,
            replyInThread: true,
            format: 'auto',
          },
        );
        deliveredReceipts.add(receiptId);
        await setReceiptStatus(receiptId, {
          status: 'delivered',
          receiptId,
          messageId: sendResult?.messageId,
          threadId: context.threadId ?? sendResult?.threadId,
          rootMessageId: context.rootMessageId,
          sentAt: Date.now(),
        });
      } catch (sendError) {
        logFailure('assistant reply send', receiptId, sendError);
        // Error remains retryable: do NOT add receiptId to deliveredReceipts
        await setReceiptStatus(receiptId, {
          status: 'failed',
          retryable: true,
          receiptId,
          error: sendError?.message ?? String(sendError),
          threadId: context.threadId,
          rootMessageId: context.rootMessageId,
          failedAt: Date.now(),
        });
      }
    }
  };

  const enqueue = (sessionId, event) => {
    if (closed || typeof sessionId !== 'string' || !sessionId) return Promise.resolve();
    const previous = tails.get(sessionId) ?? Promise.resolve();
    const task = previous.then(
      () => processEvent(sessionId, event),
      () => processEvent(sessionId, event),
    );
    const tail = task.catch((error) => logFailure('event handling', null, error)).finally(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
    tails.set(sessionId, tail);
    return tail;
  };

  const replyStatusForReceipt = async (receiptId) => {
    if (typeof receiptId !== 'string' || !receiptId) return null;
    await loadState();
    return receiptStatuses.get(receiptId) ?? null;
  };

  return Object.freeze({
    enqueue,
    replyStatusForReceipt,
    async whenIdle() {
      while (tails.size > 0) await Promise.allSettled([...tails.values()]);
      await writeQueue;
    },
    close() {
      closed = true;
      activeTurns.clear();
    },
  });
}

export function installFeishuSessionReplyRouter(ctx, deliveryService, options = {}) {
  if (typeof ctx?.on !== 'function') {
    throw new TypeError('installFeishuSessionReplyRouter requires ctx with on()');
  }
  const router = createFeishuSessionReplyRouter({
    deliveryService,
    logger: options.logger ?? console,
    stateFile: options.stateFile,
  });
  const disposeEvent = ctx.on('session/event', (session, event) => {
    const sessionId = sessionIdOf(session);
    if (!sessionId) return;
    void router.enqueue(sessionId, event);
  }, { global: true });

  let disposed = false;
  const close = () => {
    if (disposed) return;
    disposed = true;
    disposeEvent?.();
    router.close();
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => close, 'dsh-im: Feishu session reply router');
  }

  if (deliveryService && typeof deliveryService === 'object') {
    if (typeof deliveryService.setReplyStatusHandler === 'function') {
      deliveryService.setReplyStatusHandler((receiptId) => router.replyStatusForReceipt(receiptId));
    }
    deliveryService.replyStatusForReceipt = (receiptId) => router.replyStatusForReceipt(receiptId);
  }

  return Object.freeze({
    ...router,
    close,
  });
}
