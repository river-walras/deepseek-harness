# @deepseek-ai/dsh-peer-group

[English](README.md) | 中文

`ctx.peerGroups` 的 Service Definition；该注册表支持现有根 Agent 之间的横向协作。它不创建 agent（智能体），也不改变 `ctx.subagents`；一项成员资格是由 `PeerGroupId`、`SessionId` 和成员 incarnation 组成并由组限定的元组。

## 成员资格与权限

人类命令处理器创建组并变更成员资格。`PeerGroupId` 是经 `[a-z][a-z0-9_-]{0,31}` 验证的精确人类输入名称；命令和 Service 都不进行大小写折叠或规范化，并且都会拒绝无效名称。`/peer create <group>` 将发起命令的精确实时根 Agent 加入组。后续每次添加都会准入另一个现有实时根 Agent 并铸造新的 incarnation。任何精确的当前成员都可以添加、移除或解散组；组没有所有者角色。只有当调用方和目标只共享一个组时，`PeerRef` 才能省略组。

组建操作会拒绝同一份由提供方解析的规范工作区中的第二个可写成员。规范身份绝不会以路径形式公开。人类后来对 `sandbox/mode` 或 `approval/policy` 的修改优先；若该修改会产生第二个写入者，提供方会移除该成员，并向被移除成员的 Session 追加 `peer-group/membership-removed`。不会添加异步通知通道；下一次列出或发送操作的结果会反映该移除。写入路径绕过 `ctx.sandboxPolicy` 的成员按可写成员计算。

## 状态、投递与等待

成员视图分别报告可用性（`live` 或 `inactive`）和执行状态（`working`、`idle`，或带 `interaction`／`peer` 原因的 `blocked`）。当两种等待原因同时存在时，报告以 `interaction` 为先：投递必须安全失败，而仅有同级 agent 等待时仍可投递。非活动目标会让投递失败，并以 `PEER_UNAVAILABLE` 终止等待。

`send()` 在投递时授权实时调用方、目标成员 incarnation 和授权，铸造 `MessageId` 与 `PeerDeliveryId`，再通过 `Agent.followup()` 路由一条普通消息。服务会保留消息来源中的组、发送方会话、发送方 incarnation 和投递 id，但绝不将其视为权限；它会在投递时授权实时成员资格、incarnation 和授权。目标持有 `interaction` 租约时拒绝投递；仅持有 `peer` 租约时允许投递。

独立等待以状态为基础，可以立即匹配初始快照。发送等待跟随已投递的精确 `MessageId`、其 `agent/inbox/claimed` 轮次以及该轮次的后续状态。每项等待都会安装一条由组限定并经过环路检查的边，并在每种完成或失败路径上移除该边以及调用方的 `peer` 租约。

消费方在调用 `send()` 或 `wait()` 前先调用 `resolveWait()`，取得由提供方拥有的默认谓词和有界超时。这使部署默认值在 Service 边界上保持显式。

参见[同级 agent 组子系统参考](../../../docs/subsystems/peer-groups.md)和拟议的[设计记录](../../../.agents/notes/proposed/feature/2026-08-14-cross-session-peer-collaboration.md)。

## 模型体验

### 同级 agent 协作服务

#### 模型看到什么

模型只通过 `@deepseek-ai/dsh-tool-peer` 看到该服务：列表返回成员投影视图，投递返回接受 id，等待返回已记录的匹配状态或稳定错误。

#### Token 影响

直接 token 为零；Service Definition 本身不注册工具、提示词或消息。

#### KV Cache 影响

不会直接失效；消费方拥有任何新增消息或工具结果 token。

## 已知限制与延期工作

- **组仅存在于进程内** — `inactive` 表示当前进程没有精确实时根 Agent，并不承诺冷启动或跨重启恢复成员资格。
- **没有扇出、比较或 worktree 隔离** — 横向投递在共享规范工作区上维持单写入者准入；并行隔离创建属于独立能力。
- **没有 transcript 读取操作** — session-reference 和 session-query 消费方仍是结构化跨会话读取路径。
