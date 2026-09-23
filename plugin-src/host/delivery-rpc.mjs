import { registerManagementRpc } from '../management-rpc.mjs';
import { resolveRpcAuthority } from './rpc-authority.mjs';

export const DELIVERY_RPC_CHANNEL = '/dsh-im-delivery';
export const DELIVERY_TEST_MESSAGE = 'DSH-IM 主动投递测试成功。';
export const DELIVERY_ENDPOINTS = Object.freeze({
  send: 'message.send',
  listMessages: 'message.list',
  listTargets: 'target.list',
  listSuggestions: 'target.suggestion.list',
  createTarget: 'target.create',
  updateTarget: 'target.update',
  deleteTarget: 'target.delete',
  setSessionSync: 'target.session-sync.set',
  testTarget: 'target.test',
});
const ENDPOINTS = new Set(Object.values(DELIVERY_ENDPOINTS));
const PUBLIC_ERRORS = new Set([
  'bad-request',
  'unknown-bot',
  'unknown-target',
  'target-conflict',
  'invalid-target',
  'bot-not-connected',
  'target-rejected',
  'permission-denied',
  'delivery-failed',
  'session-sync-unavailable',
  'cancelled',
]);

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value, keys) {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key));
}

export function validBotId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function validTargetId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(value);
}

export function validTimeFilter(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0;
  }
  if (typeof value === 'string') {
    return /^\d{1,16}$/.test(value);
  }
  return false;
}

export function validateListMessagesOptions(options) {
  if (options === undefined) return true;
  if (!isRecord(options)) return false;
  const allowed = ['threadId', 'startTime', 'endTime', 'pageSize', 'pageToken'];
  if (Object.keys(options).some((k) => !allowed.includes(k))) return false;
  if (options.threadId !== undefined) {
    if (typeof options.threadId !== 'string' || !options.threadId.trim()) return false;
  }
  if (options.startTime !== undefined) {
    if (!validTimeFilter(options.startTime)) return false;
  }
  if (options.endTime !== undefined) {
    if (!validTimeFilter(options.endTime)) return false;
  }
  if (options.threadId !== undefined && (options.startTime !== undefined || options.endTime !== undefined)) {
    return false;
  }
  if (options.pageSize !== undefined
    && (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 50)) {
    return false;
  }
  if (options.pageToken !== undefined) {
    if (typeof options.pageToken !== 'string' || !options.pageToken.trim()) return false;
  }
  return true;
}
function validTarget(value, { targetId }) {
  const keys = targetId ? ['targetId', 'name', 'kind', 'route'] : ['name', 'kind', 'route'];
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) return false;
  if (targetId && !validTargetId(value.targetId)) return false;
  if (value.name !== undefined
    && (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80)) return false;
  return typeof value.kind === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value.kind)
    && isRecord(value.route);
}

function validDraftTarget(value) {
  return exactKeys(value, ['kind', 'route'])
    && typeof value.kind === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value.kind)
    && isRecord(value.route);
}

function validSendPayload(payload) {
  if (!isRecord(payload)) return false;
  const allowedKeys = ['botId', 'targetId', 'text', 'format', 'replyToMessageId', 'replyInThread'];
  if (Object.keys(payload).some((key) => !allowedKeys.includes(key))) return false;
  if (!validBotId(payload.botId) || !validTargetId(payload.targetId)) return false;
  if (typeof payload.text !== 'string' || !payload.text.trim()) return false;
  if (payload.format !== undefined && !['plain', 'markdown', 'auto', 'card'].includes(payload.format)) return false;
  if (payload.replyToMessageId !== undefined) {
    if (typeof payload.replyToMessageId !== 'string' || !payload.replyToMessageId.trim()) return false;
  }
  if (payload.replyInThread !== undefined) {
    if (typeof payload.replyInThread !== 'boolean') return false;
    if (payload.replyInThread && payload.replyToMessageId === undefined) return false;
  }
  return true;
}

export function validPayload(endpoint, payload) {
  if (!ENDPOINTS.has(endpoint) || !isRecord(payload)) return false;
  if (endpoint === DELIVERY_ENDPOINTS.send) {
    return validSendPayload(payload);
  }
  if (endpoint === DELIVERY_ENDPOINTS.listMessages) {
    const allowed = ['botId', 'targetId', 'options'];
    if (Object.keys(payload).some((k) => !allowed.includes(k))) return false;
    if (!validBotId(payload.botId) || !validTargetId(payload.targetId)) return false;
    return validateListMessagesOptions(payload.options);
  }
  if (endpoint === DELIVERY_ENDPOINTS.listTargets
    || endpoint === DELIVERY_ENDPOINTS.listSuggestions) {
    return exactKeys(payload, ['botId']) && validBotId(payload.botId);
  }
  if (endpoint === DELIVERY_ENDPOINTS.createTarget) {
    return exactKeys(payload, ['botId', 'target'])
      && validBotId(payload.botId) && validTarget(payload.target, { targetId: true });
  }
  if (endpoint === DELIVERY_ENDPOINTS.updateTarget) {
    return exactKeys(payload, ['botId', 'targetId', 'target'])
      && validBotId(payload.botId) && validTargetId(payload.targetId)
      && validTarget(payload.target, { targetId: false });
  }
  if (endpoint === DELIVERY_ENDPOINTS.testTarget) {
    return (exactKeys(payload, ['botId', 'targetId'])
        && validBotId(payload.botId) && validTargetId(payload.targetId))
      || (exactKeys(payload, ['botId', 'target'])
        && validBotId(payload.botId) && validDraftTarget(payload.target));
  }
  if (endpoint === DELIVERY_ENDPOINTS.setSessionSync) {
    return exactKeys(payload, ['botId', 'targetId', 'enabled'])
      && validBotId(payload.botId) && validTargetId(payload.targetId)
      && typeof payload.enabled === 'boolean';
  }
  return exactKeys(payload, ['botId', 'targetId'])
    && validBotId(payload.botId) && validTargetId(payload.targetId);
}

function publicError(error) {
  const code = PUBLIC_ERRORS.has(error?.code) ? error.code : 'delivery-failed';
  return { code, message: code, details: {} };
}

export function createDeliveryRpcHandler(service) {
  for (const method of [
    'send',
    'listTargets',
    'listSuggestions',
    'createTarget',
    'updateTarget',
    'deleteTarget',
  ]) {
    if (typeof service?.[method] !== 'function') {
      throw new TypeError(`A complete delivery service is required (${method})`);
    }
  }
  return async (endpoint, payload, signal) => {
    if (!validPayload(endpoint, payload)) {
      return {
        ok: false,
        error: { code: 'bad-request', message: 'Invalid delivery request.', details: {} },
      };
    }
    if (signal?.aborted) {
      return { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } };
    }
    try {
      let value;
      if (endpoint === DELIVERY_ENDPOINTS.send) {
        value = await service.send(payload.botId, payload.targetId, payload.text, {
          signal,
          ...(payload.format === undefined ? {} : { format: payload.format }),
          ...(payload.replyToMessageId === undefined ? {} : { replyToMessageId: payload.replyToMessageId.trim() }),
          ...(payload.replyInThread === undefined ? {} : { replyInThread: payload.replyInThread }),
        });
      } else if (endpoint === DELIVERY_ENDPOINTS.listMessages) {
        if (typeof service.listMessages !== 'function') {
          throw new TypeError('listMessages is unavailable');
        }
        value = await service.listMessages(payload.botId, payload.targetId, {
          signal,
          ...(payload.options ?? {}),
        });
      } else if (endpoint === DELIVERY_ENDPOINTS.listTargets) {
        value = await service.listTargets(payload.botId);
      } else if (endpoint === DELIVERY_ENDPOINTS.listSuggestions) {
        value = await service.listSuggestions(payload.botId);
      } else if (endpoint === DELIVERY_ENDPOINTS.createTarget) {
        value = await service.createTarget(payload.botId, payload.target);
      } else if (endpoint === DELIVERY_ENDPOINTS.updateTarget) {
        value = await service.updateTarget(payload.botId, payload.targetId, payload.target);
      } else if (endpoint === DELIVERY_ENDPOINTS.deleteTarget) {
        value = await service.deleteTarget(payload.botId, payload.targetId);
      } else if (endpoint === DELIVERY_ENDPOINTS.setSessionSync) {
        if (typeof service.setSessionSync !== 'function') {
          throw new TypeError('Session sync is unavailable');
        }
        value = await service.setSessionSync(payload.botId, payload.targetId, payload.enabled);
      } else {
        value = await service.send(
          payload.botId,
          Object.hasOwn(payload, 'target') ? payload.target : payload.targetId,
          DELIVERY_TEST_MESSAGE,
          { signal },
        );
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  };
}

export function installDeliveryRpc(ctx, service, { authority } = {}) {
  return registerManagementRpc(ctx,
    DELIVERY_RPC_CHANNEL,
    createDeliveryRpcHandler(service),
    { authority: resolveRpcAuthority(authority) },
  );
}
