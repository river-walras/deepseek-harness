# @deepseek-ai/dsh-tool-peer

[English](README.md) | 中文

基于 [`ctx.peerGroups`](../peer-group/README.md) 的 `send_to_peer`、`wait_for_peer` 和 `list_peers` 模型可见消费方。每个工具都声明通用 UI 渲染意图；展示是参数的纯函数。

## 工具约定

- `send_to_peer({ peer, message, wait? })` 默认为不等待，并返回 `{ accepted, deliveryId, messageId, peer, wait? }`，绝不返回回复。提供 `wait: { until?, timeoutMs? }` 时，等待会跟随已投递精确消息被认领的轮次。
- `wait_for_peer({ peer, until?, timeoutMs? })` 以状态为基础，可以匹配初始快照，并默认令 `until` 为 `idle | blocked`。阻塞结果报告原因为 `interaction` 还是 `peer`。
- `list_peers({ group? })` 列出可见组，而 `list_peers({ peer })` 返回一个已解析成员。只有共享成员资格可以无歧义解析时，`PeerRef` 才能省略组。

组输入是匹配 `[a-z][a-z0-9_-]{0,31}` 的精确人类输入名称；无效名称会被拒绝，且不进行大小写折叠或规范化。自动策略移除会向被移除成员的 Session 追加一条 `peer-group/*` 事件，但不创建异步通知通道。下一次 `list_peers` 或 `send_to_peer` 结果会反映该移除。

工具输入中的等待边界是可选毫秒值。经过验证的默认和最大超时是 `peer-group-local` 上的部署可调参数；提供方先将每个输入解析为有界 `PeerWaitSpec`，再调用 Service。从非工作目标开始的投递等待要求在 `min(timeout, 5000)` 毫秒内观察到效果。用户边界较短时，超时为 `WAIT_TIMEOUT`；否则缺少效果为 `PROMPT_STALLED`。

## 模型体验

### 同级 agent 协作工具

#### 模型看到什么

模型会看到全部三个 schema。`send_to_peer` 说明接受并非回复，`wait_for_peer` 说明它观察状态而非消息，`list_peers` 返回当前共享成员资格行。成功结果使用从规范值派生的紧凑 JSON 文本。

#### Token 影响

挂载本包时，三个稳定 schema 会增加提示词 token。每次调用通过普通工具日志把参数和紧凑 JSON 结果加入模型历史。

#### KV Cache 影响

挂载或卸载本包会改变工具 schema 前缀。调用不会改变后续 schema；其结果只扩展对话后缀。

## 已知限制与延期工作

- **没有回复通道** — 发送接受结果只确认进入收件箱；同级 agent 通过另一次投递回复。
- **没有读取或扇出工具** — 结构化会话检索和后续比较工作流仍属于独立消费方。
