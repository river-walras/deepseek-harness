# @deepseek-ai/dsh-tool-peer

[English](README.md) | 中文

基于 [`ctx.peers`](../peer/README.md) 的 `send_to_peer`、`wait_for_peer` 和 `list_peers` 模型可见消费方。每个工具都声明通用 UI 渲染意图；展示是参数的纯函数。

## 工具约定

- `send_to_peer({ peer, message, wait? })` 通过会话 id 或唯一用户设置标题寻址活动根。普通文本返回 `{ accepted, deliveryId, messageId, peer, wait? }`，绝不返回回复。已识别的斜杠文本改为在目标命令平面运行，并返回 `{ accepted, ranAsCommand, commandOk, commandText?, peer, wait? }`，不投递消息。因此任一实时根都能在其他任一实时根中运行该根组装的任意命令，包括 `/permission` 和 `/compact`；`peer-local.dispatchableCommands` 可以收窄可用名称。消息等待跟随精确的已认领轮次，命令等待则观察状态且不带轮次。
- `wait_for_peer({ peer, until?, timeoutMs? })` 观察一个已解析根，可以匹配其初始状态，并将 `until` 默认为 `idle | blocked`。阻塞结果报告 `interaction` 或 `peer`。
- `list_peers({})` 无需事先配置即可发现其他所有活动根，已归档会话除外。每行包含会话 id、可选标题及来源、可选工作区和 preset 标签、执行状态、写入权限，以及在该同级与调用方会因编辑同一目录而冲突时出现的 `sharesWritableWorkspace`。只有用户来源标题可作为地址。

工具输入中的等待边界是可选毫秒值。经过验证的默认和最大超时是 `peer-local` 上的部署可调参数；提供方将每个输入解析为有界 `PeerWaitSpec`。从非工作目标开始的投递等待要求在 `min(timeout, 5000)` 毫秒内观察到效果。

## 模型体验

### 同级 Agent 协作工具

#### 模型看到什么

模型会看到全部三个 schema。`send_to_peer` 区分消息接受与命令执行，`wait_for_peer` 说明它观察状态而非消息，`list_peers` 公开其他所有活动根。成功结果使用从规范值派生的紧凑 JSON。

#### Token 影响

挂载时，schema 会增加提示词 token。每次调用通过普通工具日志加入参数和紧凑 JSON 结果。

#### KV Cache 影响

挂载或卸载会改变工具 schema 前缀。调用只扩展对话后缀。

## 已知限制与延期工作

- **没有回复通道** — 接受结果只确认进入收件箱；同级 Agent 通过独立投递回复。
- **重复用户标题不能作为地址** — 标题唯一前，调用方必须使用会话 id。
- **没有读取或扇出工具** — 结构化会话检索和比较工作流仍属于独立消费方。
