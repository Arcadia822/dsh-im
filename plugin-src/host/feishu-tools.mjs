const jsonOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

export function installFeishuTools(ctx, service) {
  if (typeof ctx?.tools?.register !== 'function') return false;

  const requireFeishu = async (botId) => {
    const bots = await service.listBots();
    if (!bots.some((bot) => bot.botId === botId && bot.channel === 'feishu')) {
      const error = new Error('A configured Feishu Bot ID is required');
      error.code = 'unknown-bot';
      throw error;
    }
  };

  const resolveTarget = async (args, exec) => {
    let { botId, targetId } = args ?? {};
    if (botId && targetId) {
      await requireFeishu(botId);
      return { botId, targetId, autoResolved: null };
    }

    const sessionId = exec?.agent?.session?.header?.id;
    if (sessionId && typeof service.conversationContextForSession === 'function') {
      const autoContext = await service.conversationContextForSession(sessionId);
      if (autoContext?.botId && autoContext?.chatId) {
        botId = autoContext.botId;
        const targets = (await service.listTargets(botId))?.targets ?? [];
        const matched = targets.find((t) => t.kind === 'group' && t.route?.chatId === autoContext.chatId);
        if (matched) {
          targetId = matched.targetId;
          return { botId, targetId, autoResolved: autoContext };
        }
        return {
          botId,
          targetId: { kind: 'group', route: { chatId: autoContext.chatId } },
          autoResolved: autoContext,
        };
      }
    }

    if (!botId || !targetId) {
      const error = new Error('botId and targetId are required when calling outside a bound Feishu conversation');
      error.code = 'bad-request';
      throw error;
    }
    await requireFeishu(botId);
    return { botId, targetId, autoResolved: null };
  };

  ctx.tools.register({
    name: 'dsh_im_feishu_list_messages',
    description: 'Read Feishu group or thread actual platform history. Inside a bound Feishu group or thread session, botId and targetId are optional and default to the current conversation. Pass threadId to read a specific discussion thread in the group. Recent messages come first. Requires group-history permissions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        botId: { type: 'string', description: 'Optional inside a bound Feishu chat; otherwise configured Feishu Bot ID.' },
        targetId: { type: 'string', description: 'Optional inside a bound Feishu chat; otherwise saved delivery target ID.' },
        threadId: { type: 'string', description: 'Optional thread to read. In a thread session, defaults to current thread if omitted.' },
        startTime: { type: 'string', pattern: '^\\d+$', description: 'Inclusive start as Unix seconds; group feed only.' },
        endTime: { type: 'string', pattern: '^\\d+$', description: 'Query end as Unix seconds; group feed only.' },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
        pageToken: { type: 'string', description: 'Opaque cursor returned by previous page.' },
      },
      required: [],
    },
    output: jsonOutput,
    async execute(args, exec) {
      const resolved = await resolveTarget(args, exec);
      const effectiveThreadId = args?.threadId !== undefined
        ? args.threadId
        : (resolved.autoResolved?.threadId ?? undefined);

      return service.listMessages(resolved.botId, resolved.targetId, {
        ...(effectiveThreadId ? { threadId: effectiveThreadId } : {}),
        ...(args?.startTime !== undefined ? { startTime: args.startTime } : {}),
        ...(args?.endTime !== undefined ? { endTime: args.endTime } : {}),
        ...(args?.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
        ...(args?.pageToken !== undefined ? { pageToken: args.pageToken } : {}),
        ...(exec?.signal ? { signal: exec.signal } : {}),
      });
    },
  });

  ctx.tools.register({
    name: 'dsh_im_feishu_send',
    description: 'Deliver text, Markdown, or an interactive card to a Feishu target or the current chat session. Inside a bound Feishu chat session, botId and targetId are optional. Supply replyToMessageId and replyInThread=true to reply inside a thread.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        botId: { type: 'string', description: 'Optional inside a bound Feishu chat; otherwise configured Feishu Bot ID.' },
        targetId: { type: 'string', description: 'Optional inside a bound Feishu chat; otherwise saved delivery target ID.' },
        text: { type: 'string', minLength: 1, description: 'Message or reply content.' },
        format: { type: 'string', enum: ['plain', 'markdown'], description: 'Message format: plain text (default) or markdown.' },
        replyToMessageId: { type: 'string', description: 'Existing message ID in the group to reply to.' },
        replyInThread: { type: 'boolean', description: 'Set true to reply in a thread. Requires replyToMessageId.' },
      },
      required: ['text'],
    },
    output: jsonOutput,
    async execute(args, exec) {
      const resolved = await resolveTarget(args, exec);
      return service.send(resolved.botId, resolved.targetId, args.text, {
        format: args.format,
        replyToMessageId: args.replyToMessageId,
        replyInThread: args.replyInThread,
        ...(exec?.signal ? { signal: exec.signal } : {}),
      });
    },
  });

  return true;
}
