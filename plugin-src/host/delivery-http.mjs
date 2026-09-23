import { createDeliveryRpcHandler, DELIVERY_ENDPOINTS } from './delivery-rpc.mjs';

export const DELIVERY_HTTP_PATH = '/api/dsh-im/delivery/messages';
export const DELIVERY_MESSAGES_LIST_HTTP_PATH = '/api/dsh-im/delivery/messages/list';

const MAX_BODY_BYTES = 1024 * 1024;

const DELIVERY_ERROR_STATUS = Object.freeze({
  'bad-request': 400,
  'unknown-bot': 404,
  'unknown-target': 404,
  'target-conflict': 409,
  'invalid-target': 422,
  'bot-not-connected': 503,
  'target-rejected': 422,
  'permission-denied': 403,
  'delivery-failed': 502,
  cancelled: 408,
});
class HttpRequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(response, status, value, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

function isJsonContentType(value) {
  return typeof value === 'string'
    && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpRequestError(413, 'payload-too-large');
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new HttpRequestError(413, 'payload-too-large');
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new HttpRequestError(400, 'bad-request');
  }
}

export function createDeliveryHttpHandler(service, endpoint = DELIVERY_ENDPOINTS.send) {
  const dispatch = createDeliveryRpcHandler(service);
  return async (request, response) => {
    if (request.method !== 'POST') {
      json(response, 405, {
        error: { code: 'method-not-allowed', message: 'method-not-allowed', details: {} },
      }, { allow: 'POST' });
      return;
    }
    if (!isJsonContentType(request.headers['content-type'])) {
      json(response, 415, {
        error: { code: 'unsupported-media-type', message: 'unsupported-media-type', details: {} },
      });
      return;
    }

    const abort = new AbortController();
    const cancel = () => abort.abort();
    const cancelClosedResponse = () => {
      if (!response.writableEnded) cancel();
    };
    request.once('aborted', cancel);
    response.once('close', cancelClosedResponse);
    try {
      const payload = await readJsonBody(request);
      const result = await dispatch(endpoint, payload, abort.signal);
      if (result.ok) {
        json(response, 200, result.value);
        return;
      }
      json(response, DELIVERY_ERROR_STATUS[result.error.code] ?? 500, {
        error: result.error,
      });
    } catch (error) {
      if (error instanceof HttpRequestError) {
        json(response, error.status, {
          error: { code: error.code, message: error.code, details: {} },
        });
        return;
      }
      json(response, 500, {
        error: { code: 'delivery-failed', message: 'delivery-failed', details: {} },
      });
    } finally {
      request.off('aborted', cancel);
      response.off('close', cancelClosedResponse);
    }
  };
}

export function createDeliveryMessagesListHttpHandler(service) {
  return createDeliveryHttpHandler(service, DELIVERY_ENDPOINTS.listMessages);
}

export function installDeliveryHttp(ctx, service) {
  if (!ctx?.webServer || typeof ctx.webServer.register !== 'function'
    || typeof ctx.effect !== 'function') {
    throw new TypeError('DSH Host WebServer is required');
  }
  const sendRoute = {
    kind: 'exact',
    path: DELIVERY_HTTP_PATH,
    handler: createDeliveryHttpHandler(service),
  };
  const listRoute = {
    kind: 'exact',
    path: DELIVERY_MESSAGES_LIST_HTTP_PATH,
    handler: createDeliveryMessagesListHttpHandler(service),
  };
  return ctx.effect(
    () => {
      const unregisterSend = ctx.webServer.register(sendRoute);
      const unregisterList = ctx.webServer.register(listRoute);
      return () => {
        if (typeof unregisterList === 'function') unregisterList();
        if (typeof unregisterSend === 'function') unregisterSend();
      };
    },
    `dsh-im: ${DELIVERY_HTTP_PATH}, ${DELIVERY_MESSAGES_LIST_HTTP_PATH}`,
  );
}
