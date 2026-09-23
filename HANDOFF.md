# Handoff: dsh-im 飞书群聊 Agent 自主开楼 (Autonomous Thread) 与按群策略配置

> **目标工作区**：`~/data/dsh-im`  
> **上游仓库**：`https://github.com/xmanrui/dsh-im.git` (分支: `main`)  
> **交接时间**：2026-09-22

---

## 1. 业务背景与问题定义

当前 `dsh-im` 的飞书群聊交互中：
- 全局仅提供一个二元的 `groupTopicReply`（群聊以话题方式回复：`on` / `off`）开关。
- 若开启（`on`），所有在群内 @Bot 的提问都会被强制自动开出独立的飞书 Thread，容易造成群内话题泛滥、普通闲聊碎片化。
- 若关闭（`off`），所有公屏交互共享同一个 `group:<chatId>` Session。当遇到长流程任务（如需求评审、多轮反馈、异步汇报）时，公屏会被严重刷屏，且无法隔离上下文。

### 用户需求
1. **Agent 自主开楼（Autonomous Thread）**：
   - 默认情况下 Bot 在公屏正常回复。
   - 当任务需要长线推进（如心跳触发、异步移交、多轮评审）时，Agent 可以**自主决定是否针对历史某条发言盖楼（Thread）**，并在飞书中开出独立 Thread，将后续交互上下文无缝迁移/切分到该 Thread 专属的独立 Session 中。
   - **支持选择历史消息盖楼**：盖楼的目标并不一定是刚发送的 `last message`，可能是之前某条特定的主提案/卡片消息。
2. **按群独立配置（Per-group Policy）**：
   - 在前端管理界面中，将“群话题行为”作为一种 **Agent 行为模式（Behavior Mode）**。
   - 能够针对**当前已识别到的具体飞书群**（以静态稳定的 `chatId` 为主键，如 `oc_xxxx`，而非动态的 Session ID）独立配置行为策略。

---

## 2. 线上现有架构事实与落地勘测 (勘测基准: `host-a1`)

1. **飞书 API 原生支持 Thread 回复**：
   - `src/channels/feishu/feishu-channel.mjs` 中向飞书发消息/卡片时，调用 `im.v1.message.reply` 传入 `reply_in_thread: true`，飞书即会自动在目标消息下建立 Thread 并返回 `thread_id`。
2. **底层 Session 隔离机制天然完备**：
   - `src/channels/feishu/bridge.mjs` 的 `#resolveKey(event)` 逻辑：
     ```javascript
     if (threadId) {
       const root = this.#state?.topicRootFor?.(threadId) ?? null;
       return root && chatId
         ? managedGroupKey(chatId, root.rootMessageId) // group:<chatId>:managed:<rootMessageId>
         : `group:${chatId}:thread:${threadId}`;       // group:<chatId>:thread:<threadId>
     }
     ```
   - 只要消息处于 Thread 内，`#resolveKey` 就会天然与公屏主流的 `group:<chatId>` 形成严格的物理隔离。
   - `state-store.mjs` 具备 `setTopic(threadId, { rootMessageId, chatId })` 持久化映射能力。
3. **前端群配置位置**：
   - `plugin-src/client/channels/feishu/group-settings.js` 中的 `GroupTopicReplyEditor`。
   - 目前仅向后端提交 `FEISHU_ENDPOINTS.setGroupTopicReply` (`{ groupTopicReply: boolean }`)。
4. **群感知数据源**：
   - `workspaces.json` 中的 `deliveryTargets`（存储了群名称与 `chatId`）。
   - `bridge.mjs` 运行态维护的 `#groupChatIds = new Set()`。

---

## 3. 已确认的收敛方案

不新增按群行为模式、策略配置或前端设置。保留现有全局 `groupTopicReply` 行为；本需求仅扩展 automation 可调用的飞书能力：

1. **读取真实飞书群／话题历史**：
   - `dsh_im_feishu_list_messages({ botId, targetId, ... })` 只接受已保存的飞书群目标。
   - 群历史包含用户与 Bot 消息，并返回可用于回复的 `messageId`；已有话题可用返回的 `threadId` 继续读取楼内讨论。
   - 直接调用对应 Host 能力时，使用 `ctx.dshIm.listMessages(botId, targetId, options)`；HTTP/RPC 对应 `POST /api/dsh-im/delivery/messages/list` 与 `message.list`。
   - 飞书应用需要消息读取权限以及 `im:message.group_msg`，且 Bot 必须仍在目标群内。

2. **选择历史消息并在话题中回复**：
   - `dsh_im_feishu_send({ botId, targetId, text, format?, replyToMessageId, replyInThread: true })` 扩展既有主动投递链路。
   - dsh-im 在发送前校验锚点消息属于目标群，调用飞书 `message.reply` 并设置 `reply_in_thread: true`；失败不会降级到公屏。
   - 成功回执包含 `messageId`、`threadId` 与 `rootId`。

3. **明确不在本次范围内**：
   - 不迁移 automation Session、定时任务或心跳；automation 始终在自己的独立 Session 运行。
   - 不复制群聊 Session history 到 automation Session，不建立“最近 Bot 消息”本地缓存。
   - 不为 automation 创建的 Thread 强制写入 managed-topic 映射。
   - 用户随后在 Thread 中发送被 Bot 接受的消息时，dsh-im 现有路由会以 `group:<chatId>:thread:<threadId>` 按需创建并绑定独立 Session；已有 managed 映射保持不变。

### 验收边界

- automation 能读取已保存飞书群目标的近期历史，翻页，并按需读取指定 Thread。
- automation 能从历史中选择 `messageId`，创建或复用 Thread 并取得完整回执。
- 跨群消息、删除消息、无历史权限、无话题能力等情况明确失败，不重复发送、不回退公屏。
- 普通主动投递和现有群聊／Thread Session 路由行为保持兼容。
---

## 4. 相关代码核心路径清单 (`~/data/dsh-im`)

- **飞书消息通道与路由**：
  - `src/channels/feishu/bridge.mjs`（`#resolveKey` 路由切分、Managed Topic 注册、入站事件分发）
  - `src/channels/feishu/feishu-channel.mjs`（`reply_in_thread` 消息发送底层封装）
  - `src/channels/feishu/state-store.mjs`（Topic 与 Session 键持久化落盘）
  - `src/channels/feishu/message-utils.mjs`（`conversationKey`、`managedGroupKey` 辅助函数）
- **前端设置页面与 RPC**：
  - `plugin-src/client/channels/feishu/group-settings.js`（群设置面板与 Topic 开关 UI）
  - `plugin-src/client/channels/feishu/api.js`（前端 RPC 接口定义）
  - `plugin-src/host/channels/feishu/rpc.mjs`（后端 RPC 处理函数）
