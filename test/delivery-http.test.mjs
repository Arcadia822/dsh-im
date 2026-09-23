import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  DELIVERY_HTTP_PATH,
  DELIVERY_MESSAGES_LIST_HTTP_PATH,
  createDeliveryHttpHandler,
  createDeliveryMessagesListHttpHandler,
  installDeliveryHttp,
} from '../plugin-src/host/delivery-http.mjs';

function serviceFixture() {
  const calls = [];
  const service = {};
  for (const method of [
    'send',
    'listTargets',
    'listSuggestions',
    'createTarget',
    'updateTarget',
    'deleteTarget',
  ]) {
    service[method] = async (...args) => {
      calls.push([method, ...args]);
      return method === 'send' ? { sent: true } : { method };
    };
  }
  return { service, calls };
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}${DELIVERY_HTTP_PATH}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function request(url, { method = 'POST', body, contentType = 'application/json' } = {}) {
  const response = await fetch(url, {
    method,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    body,
  });
  return {
    status: response.status,
    allow: response.headers.get('allow'),
    body: await response.json(),
  };
}

test('delivery HTTP POST forwards the exact public payload to the shared service', async () => {
  const { service, calls } = serviceFixture();
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    const result = await request(url, {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        botId: 'bot_one',
        targetId: 'daily-report',
        text: '测试消息',
      }),
    });
    assert.deepEqual(result, {
      status: 200,
      allow: null,
      body: { sent: true },
    });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'send');
  assert.deepEqual(calls[0].slice(1, 4), ['bot_one', 'daily-report', '测试消息']);
});

test('delivery HTTP accepts public send formats and rejects invalid format before sending', async () => {
  const { service, calls } = serviceFixture();
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    const payload = { botId: 'bot_one', targetId: 'daily-report', text: '# Report\n\n**done**' };
    for (const format of ['plain', 'markdown', 'auto', 'card']) {
      const result = await request(url, { body: JSON.stringify({ ...payload, format }) });
      assert.equal(result.status, 200);
      assert.equal(calls.at(-1)[4].format, format);
      assert.equal(calls.at(-1)[3], payload.text);
    }
    for (const format of ['html', null, 1, ['markdown']]) {
      const result = await request(url, { body: JSON.stringify({ ...payload, format }) });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'bad-request');
    }
  });
  assert.equal(calls.length, 4);
});

test('delivery HTTP rejects unsupported methods, media types, JSON, fields, and oversized bodies', async () => {
  const { service, calls } = serviceFixture();
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    const method = await request(url, { method: 'GET' });
    assert.equal(method.status, 405);
    assert.equal(method.allow, 'POST');
    assert.equal(method.body.error.code, 'method-not-allowed');

    const media = await request(url, { contentType: 'text/plain', body: '{}' });
    assert.equal(media.status, 415);
    assert.equal(media.body.error.code, 'unsupported-media-type');

    const malformed = await request(url, { body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'bad-request');

    const extra = await request(url, {
      body: JSON.stringify({
        botId: 'bot_one', targetId: 'target', text: 'hello', sessionId: 'unstable',
      }),
    });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error.code, 'bad-request');

    const oversized = await request(url, {
      body: JSON.stringify({
        botId: 'bot_one', targetId: 'target', text: 'x'.repeat(1024 * 1024),
      }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, 'payload-too-large');
  });
  assert.deepEqual(calls, []);
});

test('delivery HTTP maps only stable delivery errors to HTTP status codes', async () => {
  const expected = new Map([
    ['bad-request', 400],
    ['unknown-bot', 404],
    ['unknown-target', 404],
    ['target-conflict', 409],
    ['invalid-target', 422],
    ['bot-not-connected', 503],
    ['target-rejected', 422],
    ['delivery-failed', 502],
    ['cancelled', 408],
  ]);
  const { service } = serviceFixture();
  let code = 'delivery-failed';
  service.send = async () => {
    const error = new Error(`private detail for ${code}`);
    error.code = code;
    throw error;
  };
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    for (const [candidate, status] of expected) {
      code = candidate;
      const result = await request(url, {
        body: JSON.stringify({ botId: 'bot_one', targetId: 'target', text: 'hello' }),
      });
      assert.equal(result.status, status);
      assert.deepEqual(result.body, {
        error: { code: candidate, message: candidate, details: {} },
      });
    }

    code = 'private-internal-error';
    const hidden = await request(url, {
      body: JSON.stringify({ botId: 'bot_one', targetId: 'target', text: 'hello' }),
    });
    assert.equal(hidden.status, 502);
    assert.deepEqual(hidden.body, {
      error: { code: 'delivery-failed', message: 'delivery-failed', details: {} },
    });
  });
});

test('delivery HTTP installs both send and list WebServer routes with Cordis lifecycle ownership', () => {
  const { service } = serviceFixture();
  const registrations = [];
  const effects = [];
  let disposeCount = 0;
  const dispose = () => { disposeCount += 1; };
  const ctx = {
    webServer: {
      register(route) {
        registrations.push(route);
        return dispose;
      },
    },
    effect(factory, label) {
      effects.push(label);
      return factory();
    },
  };

  const cleanup = installDeliveryHttp(ctx, service);
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.equal(disposeCount, 2);
  assert.deepEqual(effects, [`dsh-im: ${DELIVERY_HTTP_PATH}, ${DELIVERY_MESSAGES_LIST_HTTP_PATH}`]);
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].kind, 'exact');
  assert.equal(registrations[0].path, DELIVERY_HTTP_PATH);
  assert.equal(typeof registrations[0].handler, 'function');
  assert.equal(registrations[1].kind, 'exact');
  assert.equal(registrations[1].path, DELIVERY_MESSAGES_LIST_HTTP_PATH);
  assert.equal(typeof registrations[1].handler, 'function');
});

test('delivery HTTP messages list endpoint forwards valid request to service and handles errors', async () => {
  const { service, calls } = serviceFixture();
  service.listMessages = async (...args) => {
    calls.push(['listMessages', ...args]);
    return { items: [{ messageId: 'om_http_1' }], hasMore: false };
  };
  await withServer(createDeliveryMessagesListHttpHandler(service), async (url) => {
    const payload = {
      botId: 'bot_one',
      targetId: 'target_one',
      options: { pageSize: 15 },
    };
    const result = await request(url, { body: JSON.stringify(payload) });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { items: [{ messageId: 'om_http_1' }], hasMore: false });
    assert.equal(calls[0][0], 'listMessages');
    assert.equal(calls[0][1], 'bot_one');
    assert.equal(calls[0][2], 'target_one');
    assert.equal(calls[0][3].pageSize, 15);
    const draftResult = await request(url, {
      body: JSON.stringify({ botId: 'bot_one', target: { kind: 'group', route: { chatId: 'oc_unsaved' } } }),
    });
    assert.equal(draftResult.status, 400);
    assert.equal(draftResult.body.error.code, 'bad-request');
    assert.equal(calls.length, 1);


    // Permission denied maps to 403
    service.listMessages = async () => {
      const err = new Error('Permission denied');
      err.code = 'permission-denied';
      throw err;
    };
    const permDenied = await request(url, { body: JSON.stringify(payload) });
    assert.equal(permDenied.status, 403);
    assert.equal(permDenied.body.error.code, 'permission-denied');

    // Bad request
    const badReq = await request(url, { body: JSON.stringify({ botId: 'bot_one' }) });
    assert.equal(badReq.status, 400);
    assert.equal(badReq.body.error.code, 'bad-request');
  });
});

test('delivery HTTP send endpoint accepts reply fields and returns receipts', async () => {
  const { service, calls } = serviceFixture();
  service.send = async (...args) => {
    calls.push(['send', ...args]);
    return { sent: true, messageId: 'om_new_msg', threadId: 'omt_thread' };
  };
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    const payload = {
      botId: 'bot_one',
      targetId: 'target_one',
      text: 'reply message',
      replyToMessageId: 'om_root',
      replyInThread: true,
    };
    const result = await request(url, { body: JSON.stringify(payload) });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { sent: true, messageId: 'om_new_msg', threadId: 'omt_thread' });
    assert.equal(calls[0][4].replyToMessageId, 'om_root');
    assert.equal(calls[0][4].replyInThread, true);
  });
});
