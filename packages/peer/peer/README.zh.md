# @deepseek-ai/dsh-peer

[English](README.md) | 中文

`ctx.peers` 的 Service Definition；该注册表支持实时根 Agent 之间的零配置协作。根身份就是权限关系：Service 排除 subagent 子节点，但不在同一进程的根之间提供租户隔离。

## 寻址与权限

`list(caller)` 返回其他所有实时根。会话 id 是规范地址。当前用户设置的标题仅在唯一标识另一个根时才可使用；自动标题仅用于显示。解析会拒绝不存在的同级、重复用户标题或调用方自身。

`send()` 在入队前立即重新验证调用方和目标。目标因人类交互而阻塞时拒绝投递，仅因同级等待而阻塞时允许投递。共享可写工作区通过列表行与投递受理上的 `sharesWritableWorkspace` 报告，且从不因此拒绝投递：两个根编辑同一个目录是常规情形，该由读到这条事实的一方决定如何处理。

## 投递与等待

普通文本使用 `Agent.followup()` 并返回持久接受 id，绝不返回回复。目标消息记录发送方会话和投递 id 作为归因，而非权限。

能解析为目标 Agent 已组装命令的斜杠文本会被分派到该根的命令平面，而不会进入其收件箱。因此，任一实时根都能在其他任一实时根中启动该根组装的任意命令，包括 `/permission` 和 `/compact`，与人类在该会话中键入命令时一致。分派会立即返回目标会话与命令名称，不含处理器结果；目标 transcript 会记录该结果，被拒绝的执行则记录在本地日志中。命令生命周期通过 `CommandSource.kind = 'peer'` 记录发送方会话。提供方可以用 `dispatchableCommands` 收窄这项权限。

独立等待可以匹配初始状态。消息发送等待跟随已投递的精确 `MessageId`、其 `agent/inbox/claimed` 轮次及该轮次的后续状态；命令发送等待只观察状态，不与消息或轮次关联。每项等待只解析目标一次、固定 Agent 世代、安装一条进程范围内经过环路检查的边，并在每种完成或失败路径上清理。

消费方在 `send()` 或 `wait()` 前调用 `resolveWait()`，使提供方拥有默认谓词和超时上限。

参见[同级 Agent 子系统参考](../../../docs/subsystems/peers.md)和拟议的[设计记录](../../../.agents/notes/proposed/feature/2026-08-15-zero-setup-root-peer-collaboration.md)。

## 模型体验

### 同级 Agent 协作服务

#### 模型看到什么

模型只通过 `@deepseek-ai/dsh-tool-peer` 看到该服务：列表返回实时根投影，发送返回消息接受信息或命令分派接受信息，等待返回匹配状态或稳定错误。

#### Token 影响

直接 token 为零；Service Definition 不注册工具、提示词或消息。

#### KV Cache 影响

不会直接失效；消费方拥有模型可见消息和工具结果。

## 已知限制与延期工作

- **根仅存在于进程内** — 发现不会恢复冷会话，也不会跨越进程重启。
- **没有租户隔离** — 需要让互不信任的根隔离的部署必须使用独立权限边界。
- **没有 transcript 读取或扇出操作** — session-query 和 workflow 消费方负责这些任务。
