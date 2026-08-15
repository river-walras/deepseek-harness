# Agent Note: 跨会话同级 Agent 协作

Status: proposed

[English](2026-08-14-cross-session-peer-collaboration.md) | 中文

## 问题

DeepSeek Harness 已有一种纵向跨 agent（智能体）关系：`ctx.subagents` 让所有者父级获得对后代的权限。该关系有意禁止同级或无关根会话相互寻址。普通根会话可以共存，并且都能接受人类交互，但进程内没有任何能力让它们组成授权协作组、横向投递带归因的消息，或等待另一个根的执行状态。

现有 `AgentStatus` 报告 `idle | running`，而审批等待和用户问题等待只在各自交互路径或客户端展示中可知。因此，同级 agent 无法区分空闲目标与正在等待人类的目标，而仅靠状态快照还可能抹去一段完整的短暂转换。复用 subagent 祖先关系会授予错误权限，并且经该路径创建的成员无法询问人类，因为 `UserQuestionService` 只准入实时运行时根。

缺失的能力是横向且进程内的：人类准入现有根，已准入 agent 在显式授权下交换普通后续消息，有界等待观察真实运行时状态。会话日志仍必须能重建每条模型可见消息和工具结果，而不持久化临时等待租约。

## 提案

添加两个完整能力系列。`packages/agent-wait/` 定义并提供 `ctx.agentWaits`，再从问题和审批派生交互租约。`packages/peer-group/` 定义并提供 `ctx.peerGroups`，通过 `/peer` 公开仅限人类的组建操作，并通过三个模型工具公开列表、投递和等待。基础组合挂载这两个系列。

根 `AGENTS.md` 需要为这两个包组增加两条长期布局记录。2020 词的上限为增加后 1917 词的文件保留超过百分之五的余量；保留现有记录的措辞可以避免无关术语变更。

本提案不改变 `AgentStatus`、`SessionHeader.parentSession`、`SESSION_FORMAT_VERSION`、`agent-loop` 或 `ctx.subagents`，也不添加客户端或 Remote 接口。现有根会话行和对话交互处理仍是人类操作路径；`/peer list` 提供组可观测性。

## 包拓扑

| 包 | 角色 |
|---|---|
| `@deepseek-ai/dsh-agent-wait` | Service Definition：`ctx.agentWaits` 上的租约、游标、快照、转换和缺口约定 |
| `@deepseek-ai/dsh-agent-wait-local` | 进程内 Service Provider：epoch、活动租约、保留转换、确定性 Agent 清理、观察到期 |
| `@deepseek-ai/dsh-agent-wait-interaction` | 消费方：问题派发租约及审批事件派生 |
| `@deepseek-ai/dsh-peer-group` | Service Definition：`ctx.peerGroups` 上的成员资格、授权、状态、投递、归因和等待 |
| `@deepseek-ai/dsh-peer-group-local` | 进程内 Service Provider：组状态、规范工作区准入、Agent 解析、收件箱投递、等待图 |
| `@deepseek-ai/dsh-command-peer` | 人类消费方：`/peer` 组建和成员资格命令 |
| `@deepseek-ai/dsh-tool-peer` | 模型消费方：带通用渲染意图的 `send_to_peer`、`wait_for_peer` 和 `list_peers` |

Service Definition / Service Provider / Consumer 的拆分遵循[能力 seam 决策](../../implemented/architecture/2026-06-13-capability-seams.md)。横向成员资格与 [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md)和[交互式侧会话提案](2026-07-08-interactive-side-sessions.md)保持分离，因为它们的权限和生命周期需求不同。

## 等待观察

agent 等待租约的原因为 `interaction | peer`。原因描述未满足的依赖，而不是应答方。精确实时 `Agent` 拥有确定性释放；被观察的外部会话带有正数超时，可以以 `observation-timeout` 终止。进程 epoch 加单调修订号可防止重启后的计数器暗示连续性。

`agent-wait-local` 要求在 cordis.yml 中提供经过验证的正数 `retainedTransitionLimit`，因为观察协议没有隐含与部署无关的保留数量。进程内替换提供方会保留进程 epoch，但推进修订号屏障；来自旧提供方的游标会收到 `revision-gap`，而不会把替换状态视为连续状态。

`snapshot()` 使用“修订号／快照／修订号”重试。消费方先获取快照、注册变化监听器，再排空 `changes(snapshot.cursor)`，然后才依赖后续通知。存在保留转换时优先使用它，因为新快照可能吞掉一段完整的 `working → blocked → working` 区间。epoch 不匹配或保留缺口会返回新快照，并带有明确的 `epoch-changed` 或 `revision-gap` 原因。

租约是临时运行时状态，不添加 `SessionEventMap` 成员。模型只通过已记录的同级 agent 工具结果观察等待。这样既保留模型可见内容必须记录的规则，也不会假装进程内条件在进程丢失后仍然存在。

## 交互生命周期

`UserQuestionService` 增加一个提供方无关的派发钩子。它在全部验证和提供方选择完成后、`provider.ask()` 之前立即运行，并在该调用结算后恰好 dispose（资源释放）一次可选的已获取资源。租约无条件包围提供方调用；同步应答方可能只在极短时间内持有租约，但不会通过时间启发式重新分类该交互。

提供方派发前的 `ASK_ABORTED`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`、`EMPTY_QUESTIONS`、`BAD_INTENT` 和 `NO_PROVIDER` 失败不会调用钩子，也不会发布等待转换。派发后的中止或提供方拒绝会在同一结算路径中释放可选的已获取租约。审批等待从现有 `approval/asked` 和 `approval/decided` 事件派生，因此无需编辑 `dsh-user-approval`。

没有精确 `Agent` 的请求经提供方派发时仍会发出生命周期事件。没有 Session 拥有该等待，因此消费方不会获取租约。

## 成员资格与单写入者准入

成员资格是 `(PeerGroupId, SessionId, membership incarnation)`，绝不是实时 `Agent`。一个会话可以加入多个组；只有调用方和目标恰好共享一个组时，`PeerRef { group?, session }` 才能省略 `group`。授权和等待图顶点都由组限定，每项操作都授权当前成员 incarnation，而不信任持久消息归因。

`PeerGroupId` 是经 `[a-z][a-z0-9_-]{0,31}` 验证的人类输入组名。匹配是精确的，不进行大小写折叠或规范化；命令消费方和 Service 都会拒绝无效名称。任何精确的当前成员都可以添加、移除或解散组；不存在所有者角色。

只有精确的实时运行时根可以被准入。`/peer create <group>` 创建唯一命名的组并加入发起命令的根。`/peer add <group> <session>` 准入另一个现有根。`/peer remove <group> <session>`、`/peer list [group]` 和 `/peer dissolve <group>` 都显式指定组，绝不依赖隐藏的当前组状态。组建和成员资格变更仅限人类；模型工具使用现有授权，但不能创建授权。

组建操作在提供方内部解析规范工作区身份，且绝不将其作为路径公开。`create` 和 `add` 会拒绝同一规范工作区中的第二个可写成员。同一工作区的非写入成员必须已经通过 `sandbox/mode: read-only` 和 `approval/policy: never` 实现不可升权；写入路径绕过 `ctx.sandboxPolicy` 的成员按可写成员计算。不同规范工作区彼此独立。

后来的人类策略变更会被观察，而不会被否决。人类选择的 `sandbox/mode` 或 `approval/policy` 会生效；若结果会产生第二个可写成员，提供方会移除该成员资格，并在策略事件提交后向被移除成员的 Session 追加 `peer-group/membership-removed`。延后追加可避免重入 Session 接受边界。不会添加异步通知通道；下一次列出或发送操作的结果会反映已撤销的成员资格。可执行的不变式是：每个规范工作区最多有一个可写成员，后来权限违反该规则的成员会离开组。

## 状态与投递

成员状态有两个维度。可用性是 `live | inactive`；实时成员的执行状态是 `working | idle | blocked(reason: interaction | peer)`。若两种租约原因同时存在，报告以 `interaction` 为先：投递必须安全失败，而仅有同级 agent 等待时必须保持可投递。非活动目标会让投递失败并以 `PEER_UNAVAILABLE` 结束等待；冷启动以后仍可作为增量策略添加。

投递在进入队列前立即授权调用方、目标、组、授权以及双方成员 incarnation。它铸造 `MessageId` 和 `PeerDeliveryId`，再调用 `Agent.followup()`，使收件箱保留先提交后变更的行为。一个可合并扩展且 `form: 'relay'` 的 `MessageSourceMap` 成员记录组、发送方会话、发送方 incarnation 和投递 id。服务会保留这些字段作为持久归因，但绝不将其视为权限；每次投递都会授权实时成员资格、incarnation 和授权。

目标有未结算的 `interaction` 租约时拒绝投递。目标仅因 `peer` 阻塞时允许投递，因为该消息可能正是释放等待的输入。`send_to_peer` 返回投递接受结果和 id，绝不返回回复；回复是另一次独立投递。

## 等待协议

独立的 `wait_for_peer` 以状态为基础，可以匹配初始快照，并默认令谓词为 `idle | blocked`；阻塞结果报告 `interaction` 或 `peer`。`send_to_peer` 默认为不等待。提供可选的 `wait: { until?, timeoutMs? }` 时，它跟随已投递的精确 `MessageId`：观察 `agent/inbox/claimed`，捕获该消息的轮次，再等待该轮次，而不是任何已经活动的工作。

`defaultWaitTimeoutMs` 和 `maxWaitTimeoutMs` 是 `peer-group-local` 上经过验证的必填 `Config` 字段，且默认值不得大于最大值。`resolveWait()` 应用这些部署值和 `idle | blocked` 谓词默认值，因此操作只接收已解析且有界的 `PeerWaitSpec`。

基础组合提供 `retainedTransitionLimit: 512`，依据是 herdr 中作用等同的有界游标追赶环 `EventHub::MAX_EVENTS = 512`。其中的 `defaultWaitTimeoutMs: 300000` 和 `maxWaitTimeoutMs: 1800000` 是部署选择：默认值覆盖完整 agent 轮次，有限最大值则防止模型无限期停放一次调用。

每项等待都有边界。从非工作目标开始的发送等待要求在 `min(user timeout, 5000)` 毫秒内观察到状态变化。若用户自己的边界是更短的截止时间，到期是普通 `WAIT_TIMEOUT`；否则未观察到投递效果是独立的 `PROMPT_STALLED`。

等待图只会在原子检查无环后安装一条边。边包含组、等待 id、等待方会话、目标会话及 incarnation 和谓词。该边与等待方的 `peer` 租约会在 `finally` 中共同移除，覆盖谓词匹配、调用方中止、超时、等待方或目标 dispose、撤销成员资格、解散组、提供方 dispose、替换目标或订阅失败。

## 已交付设计与偏差

Stage 2 至 Stage 4 已交付两个能力家族、Provider 分发生命周期、面向用户的命令、三个模型工具、生成目录、双语参考文档和基础 bundle 组合。Stage 2 在行为上没有偏离本提案。其必填 `retainedTransitionLimit` 来自仓库规则的裁决：保留量是随部署变化的配置，因此 Provider 不会虚构 fallback。

Stage 3 修改了生成文件 `packages/core/session/src/known-event-types.ts` 中的事件词汇，尽管其其余实现范围排除了 `packages/core/`；新的持久化 `peer-group/membership-removed` 事件必须进入生成的已知事件集合。它还在最初的 Service Definition 声明之外增加了 `resolveWait(options): PeerWaitSpec`。仓库策略要求归属实现先把可选 request 解析成显式 spec，再运行 `wait()` 或 `send()`，因此 `resolveWait()` 会应用必填的 `defaultWaitTimeoutMs` 与 `maxWaitTimeoutMs`，而不会在执行过程中隐藏 `?? default`。

Stage 4 为 `peer-group-local` 增加了对 `@deepseek-ai/dsh-session-title` 的直接依赖，让 `PeerMemberView.title` 折叠最新的持久化标题并供 `/peer list` 使用；更早的声明暴露了该字段，却没有生产方。命令与工具结果格式在其他方面保持已声明的行为。Stage 4 一度出现的翻译配对与 `doc-sync` 环境失败已在本阶段前清除，不会改变已交付设计。

基础 bundle 提供 `retainedTransitionLimit: 512`、`defaultWaitTimeoutMs: 300000` 与 `maxWaitTimeoutMs: 1800000`；这些是显式部署选择，而不是 package 默认值。被否决的策略写入 pre-commit veto 并不存在：形成组时拒绝第二个 writer，而后续的人类策略决策会生效，并移除违反约束的成员。

## 考虑过的替代方案

**把 subagent 父级权限提升为通用 agent 目录。** 否决，因为祖先关系授予纵向生命周期控制，而同级 agent 组需要人类发放的横向成员资格。弱化直接父级和祖先检查会使 `ctx.subagents` 超出其文档化权限，而且仍不会让被拥有的子级符合人类问题的准入条件。

**只使用 `Agent.followup()` 作为仅发送邮箱。** 否决，因为没有状态观察的投递无法实现所需协作协议。有界独立等待、与投递相关的等待、环路拒绝和真实阻塞原因都是当前消费方，而非推测性抽象。

**在策略写入上设置提交前否决。** 否决，因为这要求编辑所属写入路径，并会覆盖人类对其自己会话作出的显式决定。单次调用升权本来就不变更任何策略，并且已被 `approval/policy: never` 从结构上拒绝。组建准入属于 `ctx.peerGroups`；后来的人类策略变更保持权威，并移除违反规则的成员。

**把快速用户问题提供方分类为非人类等待。** 否决，因为没有稳定或有依据的可观察时间截止点。租约无条件包围提供方派发，并描述未结算的交互，而不是提供方实现。

**把等待租约持久化为会话事件。** 否决，因为租约描述临时进程观察结果。持久化会在进程丢失后产生虚假的阻塞状态；已记录的工具结果已经保存每项模型可见观察结果。

**允许 agent 创建或添加成员。** 否决，因为可达性不是成员资格权限。仅限人类的命令使授权显式，而已准入的协调者仍可自主执行列表、投递和等待。

**从当前选择推断 `/peer add` 的组。** 否决，因为会话可以加入多个组，隐藏命令状态会产生有歧义的变更。每条变更命令都显式携带 `<group>`。

**要求本阶段提供专用多 agent UI。** 否决，因为成员是现有对话界面中已经可见且可回答的普通根会话。组内聚合、人类注意力聚合路由和专用比较界面仍可作为增量产品工作添加。

**与消息功能一起交付 worktree、扇出和优胜结果比较。** 否决，因为带有组建期单写入者准入的横向协作是安全的。并行创建可写成员需要独立的工作区隔离能力和不同的扇出／比较身份；它不要求破坏同级 agent 成员资格或投递。

**公开外部 shell 控制平面或冷启动。** 本阶段否决。产品拥有进程内根和现有 UI 界面；远程传输和启动会添加当前消费方不需要的线协议身份、持久化、存活性和授权约定。

## 验收标准

- 两个能力系列都有独立的 Service Definition、Service Provider 和当前消费方包、包 README、公开声明以及包自有不变式配套插件。
- agent-wait 测试覆盖租约获取／释放、精确 Agent dispose、观察超时、单调修订号、快照重试、保留转换、修订号缺口、epoch 替换、监听器隔离、HMR（热模块替换）替换和提供方 dispose。
- 用户问题测试证明每项派发前失败不产生转换，并且同步完成、异步完成、拒绝和派发后中止都恰好释放一次；审批测试证明无需编辑 `dsh-user-approval` 即可从 asked/decided 派生。
- peer-group 测试覆盖仅限根准入、多组、有歧义引用、incarnation 替换、实时／非活动状态、两种阻塞原因、修正后的单写入者准入、后来策略变更触发移除、实时授权、收件箱提交顺序、持久消息归因、投递拒绝／允许、等待环路、每种等待结束、HMR 替换和提供方 dispose。
- `/peer` 实现精确语法并报告要求的当前成员字段；自动策略移除会追加所需会话事件，并由下一次模型列表或发送操作反映；该命令有一份来自真实组合的产品 snapshot（快照）以及一张来自真实 Web 流程的 GIF。
- `send_to_peer`、`wait_for_peer` 和 `list_peers` 使用通用渲染意图、有界配置、投递相关性、稳定错误，以及无密钥真实组合 transcript snapshot。
- 基础组合包挂载 Service Definitions、Providers、命令、工具和相关不变式配套插件；聚焦的类型检查、lint、构建、hygiene、文档和运行时检查通过。

## 风险

若环路检测或清理不是原子的，等待图可能死锁；首次结算胜出和每项等待只有一个生命周期所有者必须使移除边与释放租约不可分离。监听器或提供方 dispose 失败还可能留下状态或挂住清理。

横向消息可能产生无界 token 和轮次成本。默认不等待的投递、显式有界等待、不暗示回复以及缺少扇出限制了初始放大，但未来仍可能需要速率或对话预算。

成员资格缺陷可能演变为权限提升。实时投递必须在提交时重新检查组、授权、调用方和目标 incarnation、精确根身份及交互阻塞状态；持久来源字段不能替代这些检查。

单写入者规则只能分类提供方能够知道的写入路径。绕过 `ctx.sandboxPolicy` 的插件必须声明成员可写；错误声明会削弱保证。在人类策略变更后移除成员保留了人类权限，但可能让活动协作意外中断，因此被移除的 Session 必须收到生命周期事件，后续同级 agent 操作也必须显露已撤销的成员资格。

进程内组和租约会在重启时消失，非活动成员也不会恢复。这些是有意限制，但调用方必须收到明确的 `PEER_UNAVAILABLE`、epoch 变化和提供方 dispose 结果，而不是无限等待或被暗示存在持久性。
