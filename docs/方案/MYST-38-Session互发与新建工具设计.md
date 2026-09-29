# MYST-38：Session 互发与新建工具设计

> 状态：待人工评审的技术设计；未实现、未部署、未通过原工单的现场验收。本文只设计类似 Codex「创建独立会话、向会话送入输入、观察结果」的能力，不把 Codex 的内部实现当作 DSH 已有接口。
>
> 主工单：[Linear MYST-38](https://linear.app/castrel/issue/MYST-38)；补充追溯：[Mystra GitHub #64](https://github.com/Arcadia822/mystra/issues/64)。参考既有[项目群业务设计](MYST-38-飞书话题与跨会话投递方案.md)与本地 `~/Documents/dsh-message-gateway`；后者属于另一仓库，接口变更须在那里另行实施。本稿唯一规范源是本 Markdown；Taco 仅供评审。

## 1. 需求、范围与验收

用户需要两个可组合的动作：①在已经核准的工作区内创建新的、可独立运行和恢复的 DSH 根 Session；②一个 Agent 向指定且获授权的其他 Session 送入 `user` 角色的消息，激活正常 Agent 收件箱/轮次。第三个只读动作查询接受回执和运行结果。支持 bot、hook、scheduler 由受信 Host 适配器复用投递路径，不伪装成真实用户飞书事件。新建不自动意味着发送首条消息，发送回执也不意味着模型已执行完毕。

飞书旅程是该通用能力的调用方：群 Agent 确认明确委派、Issue/仓库/权限之后，才在原群消息上开 Thread；Host 把 `(botId, chatId, threadId)` 与任务工作区和 Session 关联，向新 Session 发首条设计输入，不要求用户二次 @；后续 Thread 人类输入续接当前会话，答复只回原 Thread。普通查询不建楼；不打开全局 `groupTopicReply`。同群/同 Thread 可有多个 Session；工作区归属与当前接收人类消息的 Session 分开管理。

**本轮设计可检查的契约验收**：获授权者能复用 `requestId` 新建且得到稳定 Session 身份；按精确目标授权投递带真实来源的 `user/message`，重复请求不重复轮次；不同群/Issue 或旧代际不可串投；排队、运行、完成、失败、不确定彼此可区分；新会话在同一工作区冷恢复，旧会话不被静默改绑；飞书首轮与后续回复位置按同一 Thread 验证。本轮仅审查这些规格；运行证据留给实施阶段。

**非目标**：把 assistant 输出发飞书、伪造人的 IM 入站、无权限创建任意目录/Session、自动跨工作区写入、实现 OpenSandbox/发布 Taco/改 Linear 状态。工单原要求的这些运行链路仍有效，见 §8 的逐条对应和 §9 的待决策点。

## 2. 证据与既有能力边界

- `dsh-message-gateway/src/index.mjs:148-213`：`registerBinding` 只接受已运行或可恢复的 Agent Session，冻结 `owner + sessionId + cwd`；`deliver` 检查精确 `namespace/key` ACL 和 generation、按主体 `requestId` 去重，`Agent.followup(createUserMessage(...))` 后 flush，回执 `queued`，失败可能为 `unknown`。`src/tools.mjs:6-53` 已有 `dsh_message_gateway_deliver/query`；生产者准入目前来自静态配置或 preset，尚无按新 Session/Thread 动态授权。仓库 README 明确冒烟使用合成 Agent/flush，而非真实模型。
- 本 PR 的基线是 `xmanrui/dsh-im` 的 `origin/main` 提交 `6626026`。基线中 `src/channels/feishu/state-store.mjs:79-95` 是每个 conversation key 一个当前 Session；`bridge.mjs:840-855` 区分群与 Thread，`workspace-session.mjs:118-175` 可以边绑定边 `session.ask`，但会走普通 prompt，不保留跨会话投递来源。`harness-client.mjs:1204-1216` 可经 `session.create` 建会话；仍需在 Host 验证实际 Agent 创建、恢复与 gateway 的 `ctx.agents` 注册表一致。基线并未接入 `messageGateway`。
- 本机 `dsh-im/main` 另有尚未并入本 PR 基线的 `cd00b0f..42a3c16` 四项飞书话题/主动发送提交，其中 `dsh_im_feishu_send` 能以 `replyToMessageId + replyInThread` 返回 `threadId`，但仅是一次飞书发送；本设计依赖此能力时必须先并入或另行提供等效能力，不能写成当前 PR 基线已经支持。原有飞书文字回复 `bridge.mjs` 可在 reply 失败后回退主群；任务 Thread 输出必须禁止这种跨位置降级。仓库 `CONTEXT.md:23-29` 区分会话路由、主动投递目标与 Harness Session 身份。
- 既有[飞书群聊话题回复设计](飞书群聊话题回复设计.md)假定一个话题一个当前 Session；项目群业务设计另要求同 Thread 多 Session。新的集合/活跃指针必须兼容旧 `state.sessions` 入口，不能让多 Session 都消费同一条人的消息。

## 3. 方案与取舍

采用 **Host 编排 + 受信投递网关 + dsh-im 渠道路由** 三层，而非在工具内伪造飞书事件或直接调用 `session.prompt`。Host 验证发起 Session、可访问工作区、用途/角色 preset 与目标授权，负责新建根 Session、持久化操作状态和精确 grant；gateway 继续负责非人类来源的入队、去重、flush 与回执；dsh-im 只负责飞书 Thread/工作区/当前 Session 映射及回帖。`session.prompt` 或 `askInWorkspaceSession` 可服务真实人类入站，不替代带非人类 provenance 的投递。

两个模型可见工具与一个查询工具（名称是拟议接口，非现有实现）：

| 工具 | 必填输入 | 返回 | 约束 |
| --- | --- | --- | --- |
| `dsh_session_spawn` | `workspaceRef`、`rolePreset`、`requestId`；可选 `initialMessage` | `operationId`、`sessionId`、精确绑定 `target`、`creation`；有首条输入时另有 `receipt` | 工作区引用与 preset 必须预先授权；重复请求返回原结果，不创建第二个会话；没有首条内容时只建会话，不启动轮次 |
| `dsh_session_send_input` | `target: {namespace,key,expectedGeneration}`、`requestId`、`content` | `receiptId`、`sessionId`、`admission`、`execution` | 只能向本执行身份获授权的**精确**绑定投递；不能从模型输入指定伪造 `initiator` |
| `dsh_session_query` | `receiptId` 或新建的 `operationId`（标明查询类型） | 新建状态，或投递 `queued/running/completed/failed/unknown` | 只允许原主体或获授权的监督者查询；不将“已接受”显示成“已完成” |

建议实际落地时复用已有 `dsh_message_gateway_deliver/query` 语义：若改工具名称，要一次性迁移已有调用方与文档；不保留含糊的同名别义别名。Host 可为首轮调用提供 `initialMessage` 便利组合，但持久化两个独立结果（创建和投递），绝不以“创建成功”冒充“消息已接受”。`workspaceRef` 是受信工作区注册表中的不透明键，不能由模型给出任意 `cwd`、Git URL 或 `botId`；`rolePreset` 为允许列表中针对该工作区的 preset，不接受任意插件/权限声明。工具执行态提供 `senderSessionId`，Host 推导 principal 和可达目标；真实事件源由受信 hook/scheduler 适配器验证，统一进入同一 gateway，不让文本宣称身份。

### 3.1 会话新建与首轮顺序

1. Host 从实际执行 Session 身份及工作区注册表校验授权；按 `(principalId, requestId)` 持久预留新建操作，保存输入摘要、目标工作区版本与请求指纹。指纹改变返回冲突。
2. 取得工作区级互斥，检查工作区存在、归属和代际，使用受信 preset 创建独立**根** Session。实现须确认 DSH Host 真实 Agent registry 中已存在可运行/可恢复的同 ID Agent；只有 `session.create` 返回 ID 不足以证明这一点。将 `sessionId` 和创建状态持久化；若创建与写入之间崩溃且不能由确定 ID/Host 元数据恢复，则记 `unknown`，需人工对账，不盲建第二个。
3. 绑定不可变的 `namespace/key -> {sessionId,cwd,owner,generation}`；目标键包括工作区作用域和该 Session 的稳定身份，不把整个 Thread 当作单一 Session 地址。根据发起主体与目标作用域授予精确访问；重复新建与绑定返回相同绑定，冲突拒绝。若有首条输入，绑定及回帖位置先持久确认，然后按同一操作派生的稳定投递 `requestId` 调用 gateway；其回执单独记录。
4. 失效、归档或重置当前 Session 不删除旧 transcript 或悄悄把 gateway 绑定指向新 ID：新 Session 得到新目标键；dsh-im 仅切换 Thread 的 `activeSessionId` 并提高路由代际。旧 `expectedGeneration` 与旧路由指针不能发送到替身；获授权者可明确指定原 Session 续作。

### 3.2 Feishu Thread 用户旅程

经准入和 Issue/仓库验证后才取得原群消息 ID；以 `(botId,chatId,issueId)` 锁住“已有 Thread/创建中”操作，检查同群同 Issue 旧映射。调用可回传 `threadId/rootId/messageId` 的受信飞书 reply 并确认属于该群；持久登记 Thread/任务工作区关系，成功后再创建并绑定 Session、授权首轮输入。飞书建楼是外部副作用：超时或回执缺 `threadId` 时先查平台/记录对账，不能盲目再次发送。工作区准备失败、Session 新建不确定、消息投递 `unknown` 均保持“待修复”，后续使用原 Thread 和同一个 `requestId` 恢复；不以共享群 Session 顶替，也不把 Thread 的答复回退群公屏。

入站携带 `thread_id` 时，仅查本 bot/群/Thread 的持久路由与 `activeSessionId`；真实人类消息按原始渠道来源交给该 Session。若路由尚未就绪，不自行建第二个任务或串到群共享 Session；保存可核查的失败/待处理状态并在授权位置说明。出站从目标 Session 的受信绑定反查 chat/thread 和可用的 Thread 内回复锚点；锚点失效则报告失败、待修复，不调用普通群发作为自动 fallback。并发/完成回调再次验证 bot、群、Issue、Thread 与活跃路由代际，避免旧 Session 回复到新会话或错误群。

## 4. 数据与接口契约

| 记录 | 关键字段与不变量 | 持久化所有者 |
| --- | --- | --- |
| 工作区登记 | `workspaceRef, ownerScope, cwd, generation, allowedPresets`；精确归属/授权，路径由 Host 解析并验证 | Host 工作区服务 |
| 会话新建操作 | `principalId, requestId, fingerprint, operationId, workspaceRef, sessionId?, state, error?`；同主体同请求唯一，不确定不可自动重放 | Host 编排服务 |
| 网关绑定/授权 | `namespace,key,sessionId,cwd,owner,generation` 与主体到**精确**键的 grant；不可凭模型声明任意目标 | gateway/受信策略管理器 |
| 投递回执 | `receiptId, principalId, requestId, target, source, admission, execution`；排队与完成两态分离 | gateway |
| 飞书任务路由 | `botId,chatId,issueId,rootMessageId,threadId,workspaceRef,sessionIds[],activeSessionId?,routeGeneration,replyAnchorId?,state`；每个任务只绑定一个确定群及 Issue | dsh-im/Host 路由服务 |

`source.kind` 保持 `plugin:dsh-message-gateway`（或经确认的等效非人类插件标识），含受信 `principalId`、`initiatorKind`、`sourceId`、`senderSessionId?`、`requestId`、`receiptId`；`role: user` 描述模型输入位置，**不表示人类发送者**。人类飞书事件保留既有真实渠道来源；不得在此工具写 `source.kind: user`。工具接入点不曝光生产者 token 或绑定管理权。`sessionId` 可作为返回值用于审计，但不是权限凭据；授权仍按受信执行身份与精确目标检查。

错误分为：`forbidden`/`target-not-found`/`stale-generation`/`workspace-mismatch`/`idempotency-conflict` 明确拒绝，不发新输入；`not-ready`/创建或 flush 中断导致 `unknown`，先查询/对账；`accepted + queued` 仅成功入队，后续 `completed`/`failed` 以同一 `receiptId` 查询。忙碌 Session 的消息进入有序队列而非覆盖当前轮次；真正的 FIFO、终态判定及冷恢复由 DSH Host + gateway 实机验证，不能由本设计替它们保证。重复 Feishu 事件与重复工具请求分别以平台消息 ID 和按主体 `requestId` 去重，两个键不可互换。禁止向当前正在输出的 Session 发输入后不加约束地把该输出当本次请求结果。

## 5. 迁移、兼容与回滚

在原 `state.sessions[conversationKey]` 保留唯一**活跃** Session 的兼容投影，另建 Thread→工作区→Session 集合的受信记录，迁移只补充已验证的 bot/chat/thread 根锚及既有会话；缺身份或群归属的历史话题保持旧行为，不猜 Issue/工作区。已有 `/new`/切换会话只变更活跃指针，除非现有接口明确需要，旧 transcript、工作区和受信 gateway binding 均不删除。迁移写入、双读及回滚要按 bot/chat/Thread 隔离，不能混用历史按 `threadId` 单独作为跨 bot 全局地址的旧记录。旧模型工具不自动获得新的 grant；灰度先 Host 管理调用，再授权指定 Agent preset 和 hook/scheduler，最后启用飞书首轮绑定。停用时关闭新入口，保留已创建 Session/回执供审计，原有群聊和人工 Thread 对话继续沿旧路径；不将新 Thread 已入队任务回放到群。

本设计 PR 以 `origin/main` 为基线，**尚未包含**本地 `main` 的飞书 one-shot 建楼/回执改动，也不包含独立 gateway 仓库的代码。上线前需核对合并版本、Host 与 DSH 依赖、两边部署 tarball/manifest 及 gateway 配置；文档或本地测试通过不等于 host-a1 已升级。旧 PR #282 已关闭且包含不同的业务 Skill 设计，本 PR 不复用其审批结论。

## 6. 验证计划与证据

| 场景 | 观察点与失败边界 |
| --- | --- |
| 合法 spawn 与重复同键 | 实际 DSH Host 只出现一个可运行且可恢复的根 Agent Session，`cwd` 与授权工作区一致；返回稳定 `operationId/sessionId`；请求内容变更冲突；创建后无首条消息不启动轮次 |
| 跨 Session send 与冷恢复 | A 送 B：B 真实日志新增非人类来源 `user/message` 且启动一轮；`receipt` 先 queued 后 running/completed；B 正忙排队依序、冷态恢复仍归 B；同 `requestId` 只有一次输入，错目标/旧代际被拒绝 |
| 权限与来源 | 两个 bot/群/Issue 并发、未授权跨目标、模型伪造 sender/`cwd`、hook/scheduler 冒充 Agent 均拒绝或保留真实已认证来源；不读其他 Issue 内容 |
| Feishu 首轮与续作 | 实测无效 ID 不建 Thread；验证后同群同 Issue 只一楼；群/Thread Session 不同且工作区归属正确，首轮自动启动；后续人类 Thread 消息进入活跃 Session，结果只在原 Thread；多个 Session 切换不覆盖旧历史 |
| 失败与恢复 | 建楼成功但建工作区失败、建 Agent 后崩溃、flush 后回执未确认、回帖锚点丢失/平台失败：阶段可查询；不盲发第二楼/第二轮、不回退公屏，人工可对账后恢复 |

先在独立 gateway 仓库验证 admission、动态精确 grant 和真实 Host Agent 创建/恢复，再以 dsh-im 集成测试覆盖路由与旧单 Session 对话，再在授权飞书测试群用两个真实 Issue 验证首轮、并发、失败与回帖。Host 配置/模型/插件权限及依赖版本记录在实施验收；真实 webhook 与 scheduler 各跑一次同一路径。单测与合成 smoke 不能替代真实模型、持久化或飞书客户端观察。

## 7. 实现任务（设计交接，未执行）

1. 在独立 gateway/Host 接线处设计并实现可信工作区注册、Agent Session 创建或恢复、创建操作状态与精确动态 grant；核对 DSH `ctx.agents` factory/Session ID 契约，验证冷态与崩溃补偿；不将管理员 `binds` 能力给模型。
2. 在 gateway 中基于现有投递语义补足为新 Session 授权、按执行 Session 身份生成 provenance、查询创建/投递状态与代际隔离；按统一接口迁移 Agent/hook/scheduler 调用，添加异常状态测试。
3. 在 dsh-im 中实现经验证的群根消息获取、建楼回执/恢复、Thread 任务工作区及多 Session 持久映射、活跃会话门禁和仅 Thread 回帖；保留旧会话路由兼容与关闭新功能的安全回滚。
4. 启用前整合本地尚未并入基线的飞书 one-shot 能力或等效 Host API，升级清单与部署包逐项核对；用真实 Agent/两个群和两个 Issue 跑 §6 全部关键场景，保留回执、Session 日志与飞书消息 ID。
5. 若产品仍采用原工单完整旅程，另按批准的范围实现 host-c1 OpenSandbox、仓库/模型执行、Taco 发布和 Issue 状态门禁，再跑原工单端到端验收；本工具设计不冒充此交付。

## 8. 与 Linear MYST-38 原验收逐条对应

| 原工单验收 | 本工具方案对应及不能宣称完成的部分 |
| --- | --- |
| A1 真实飞书测试群、Issue 核实后唯一 Thread、群/Thread Session 隔离、首轮无需二次 @ | §3.2、§4、§6 给出路由、创建/投递顺序与可执行验收；尚无代码/真实群验证。原工单还要求实际设计任务及回复，本工具只是其必要基础而非完整任务执行 |
| A2 host-a1→host-c1 OpenSandbox 实际创建/执行/清理、真实模型仓库与双 Issue 隔离 | 只有工作区与 Session 隔离契约及测试设计；OpenSandbox 创建/执行/清理及真实仓库/模型未纳入工具范围，更不能以普通工作区替代沙箱隔离；若保留原验收必须独立实现与实测 |
| A3 发布真实 Taco URL、正确关联 Issue、成功才进 `In Review`、原 Thread 回帖，失败可安全重试 | 仅设计 §3.2 的 Thread 定向回帖及可恢复回执；发布、URL/Issue 联动与状态门禁均为后续交付，不因本次本地 Taco 存在就宣称已发布 |
| A4 host-a1/host-c1 配置/网络/模型/发布域名及真实端到端冒烟 | §6 列出工具和真实飞书的验证方法；跨主机、发布域名及原旅程的现场证据仍缺，正式验收必须另取证 |

## 9. 待决策点

### D1：原工单完整交付与本轮工具设计如何归属

- **问题与背景**：Linear MYST-38 当前标题和 A2–A4 仍要求 host-c1 OpenSandbox、发布链接与实机验收；用户近期把项目群业务 Skill 设计从具体 runtime 中拆出，本轮又明确要求规划 Session 工具。未经工单变更，不可用工具设计代替完整验收。
- **选项与取舍**：A. 保持 MYST-38 完整原验收，工具设计作为其中一条必要实施线；后续仍需沙箱/发布/实测，工期和依赖更大。B. 负责人正式拆分/修改工单，将 Session 工具独立追踪；范围更清楚，但需维护新 Issue 与旧工单的依赖和追溯。
- **推荐及理由**：B；可独立验收通用基础能力，同时不冲掉原 Issue 运行门禁。**影响面**：后续任务/PR 归属、上线门槛、Issue 状态与跨仓库所有权。**未决默认**：不改 Issue、不宣称原验收完成；按现有 A1–A4 保留后续交付要求。

### D2：新 Session 的工作区/跨工作区授权边界

- **问题与背景**：群和 Thread 可能有多个 Session，既有业务设计允许授权后双向互见/写入；新建工具若接受任意路径或让 Agent 自动赋予跨 Issue 权限，会越过该边界。具体授权主体与跨写冲突规则尚无用户裁决。
- **选项与取舍**：A. 初期仅允许创建/互发于已登记且同一任务工作区内的受信目标，跨工作区操作须 Host 管理员另授精确目标权限；首批功能较窄但隔离明确。B. 允许群 Agent 基于经核实的父子工作区关系申请动态跨工作区 grant；协作更快，但需审批主体、冲突检测和撤权规则。
- **推荐及理由**：A；先保证新工具不扩大已有工作区能力，再设计 B 的权限流程。**影响面**：工作区注册、Agent preset、双向协作、审计与验收场景。**未决默认**：跨工作区创建/发送拒绝，已有人工飞书对话保持原状；不自动把双向可见降为永久只读。

## 10. 独立审查记录

审查结论在独立审查完成后写入本节；此处不以此前业务 Skill 或旧技术稿的审查充当本稿批准。人工评审和实施批准仍分别进行。
