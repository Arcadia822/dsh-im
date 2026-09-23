import {
  parsedMessageContent,
  interactiveCardText,
  postContent,
} from './message-utils.mjs';

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeTimestampToIso(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const date = new Date(Number(raw));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Normalizes one Feishu API message object into the standard contract item.
 * @param {object} item Raw item from im.v1.message.list
 * @returns {object}
 */
export function normalizeFeishuHistoryMessage(item) {
  const messageId = nonEmptyString(item?.message_id);
  const rootId = nonEmptyString(item?.root_id);
  const parentId = nonEmptyString(item?.parent_id);
  const threadId = nonEmptyString(item?.thread_id);
  const chatId = nonEmptyString(item?.chat_id);
  const messageType = nonEmptyString(item?.msg_type) ?? 'unknown';
  const deleted = item?.deleted === true;

  const rawBodyContent = item?.body?.content;
  const fakeEvent = {
    message: {
      message_id: messageId,
      message_type: messageType,
      content: rawBodyContent,
      mentions: item?.mentions ?? [],
    },
  };

  const parsed = parsedMessageContent(fakeEvent);
  let text = '';
  let unsupported = false;
  const attachments = [];

  if (deleted) {
    text = '';
  } else if (messageType === 'text') {
    let rawText = typeof parsed?.text === 'string' ? parsed.text : '';
    for (const mention of item?.mentions ?? []) {
      if (typeof mention?.key === 'string' && mention.key) {
        rawText = rawText.replaceAll(mention.key, '');
      }
    }
    text = rawText.trim();
  } else if (messageType === 'post') {
    const post = postContent(fakeEvent, parsed);
    text = post?.text ?? '';
    for (const key of post?.imageKeys ?? []) {
      attachments.push({ kind: 'image', key });
    }
  } else if (messageType === 'interactive') {
    text = interactiveCardText(parsed);
  } else if (messageType === 'image') {
    const imageKey = nonEmptyString(parsed?.image_key);
    if (imageKey) attachments.push({ kind: 'image', key: imageKey });
    text = '';
  } else if (messageType === 'file') {
    const fileKey = nonEmptyString(parsed?.file_key);
    const fileName = nonEmptyString(parsed?.file_name);
    attachments.push({ kind: 'file', key: fileKey, name: fileName });
    text = fileName ? `[文件: ${fileName}]` : '[文件]';
  } else if (messageType === 'audio') {
    attachments.push({ kind: 'audio', key: nonEmptyString(parsed?.file_key) });
    text = '[语音]';
  } else if (messageType === 'media') {
    attachments.push({
      kind: 'media',
      fileKey: nonEmptyString(parsed?.file_key),
      imageKey: nonEmptyString(parsed?.image_key),
      fileName: nonEmptyString(parsed?.file_name),
    });
    text = '[视频]';
  } else if (messageType === 'sticker') {
    attachments.push({ kind: 'sticker', key: nonEmptyString(parsed?.file_key) });
    text = '[表情]';
  } else {
    unsupported = true;
    text = `[不支持的消息类型: ${messageType}]`;
  }

  const senderId = nonEmptyString(item?.sender?.id);
  const senderType = nonEmptyString(item?.sender?.sender_type);
  const senderName = nonEmptyString(item?.sender?.sender_name);

  return {
    messageId,
    ...(chatId ? { chatId } : {}),
    ...(rootId ? { rootId } : {}),
    ...(parentId ? { parentId } : {}),
    ...(threadId ? { threadId } : {}),
    sender: {
      ...(senderId ? { id: senderId } : {}),
      ...(senderType ? { senderType } : {}),
      ...(senderName ? { senderName } : {}),
    },
    messageType,
    createdAt: normalizeTimestampToIso(item?.create_time),
    ...(item?.update_time ? { updatedAt: normalizeTimestampToIso(item?.update_time) } : {}),
    deleted,
    text,
    ...(deleted ? {} : { content: parsed }),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(unsupported ? { unsupported: true } : {}),
  };
}

/** Query timestamps are Unix seconds, never inferred from magnitude. */
export function normalizeTimeFilterToSeconds(value, fieldName) {
  if (value === undefined) return null;
  const seconds = typeof value === 'string' && /^\d+$/u.test(value)
    ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0) {
    const error = new TypeError(`${fieldName} must be non-negative integer Unix seconds`);
    error.code = 'bad-request';
    throw error;
  }
  return seconds;
}
