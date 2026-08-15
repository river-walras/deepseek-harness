# @deepseek-ai/dsh-peer-group-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-peer-group`](../peer-group/README.md) 的进程内 Service Provider 包。它安装 `ctx.peerGroups`，拥有经 `[a-z][a-z0-9_-]{0,31}` 验证且不进行大小写折叠或规范化的精确人类输入组名、铸造成员 incarnation、解析实时根 Agent 的可用性和最新持久会话标题、依据不透明的规范工作区身份分类写入权限、授权投递并维护等待图。Service 会拒绝无效组名。

组建操作在 `create` 和 `add` 内部检查单写入者规则。提供方观察后续 `sandbox/mode` 和 `approval/policy` 变化；人类的新策略保持权威，会违反规则的成员资格会被移除。移除操作会在策略事件提交后向被移除成员的 Session 追加 `peer-group/membership-removed`，不创建异步通知，并由下一次列出或发送操作的结果反映。等待清理覆盖谓词匹配、中止、超时、任一 Agent 的 dispose（资源释放）、撤销成员资格、解散组、替换目标 incarnation、订阅失败以及提供方 dispose。

`defaultWaitTimeoutMs` 和 `maxWaitTimeoutMs` 是必填的正整数 Cordis 配置字段，没有隐式部署值；默认值不得大于最大值。`resolveWait()` 应用配置默认值、限制显式毫秒数，并在 `send()` 或 `wait()` 接收 `PeerWaitSpec` 前将状态集合默认为 `idle | blocked`。

执行状态遵循 Agent-wait 游标协议：提供方先获取快照，再从该游标后订阅并排空保留的转换，仅在 `epoch-changed` 或 `revision-gap` 后替换投影。投递拒绝 `interaction`、允许 `peer`，并在 `Agent.followup()` 前立即重新授权两个当前 incarnation。投递关联等待在自身 `MessageId` 被认领前不会匹配；独立等待可以匹配初始状态。

## 模型体验

### 进程内同级 agent 协调

#### 模型看到什么

不会直接看到来自 `ctx.peerGroups` 的任何内容；命令和工具消费方拥有人类可见及模型可见的全部输出。

#### Token 影响

直接 token 为零；成员资格、授权和图边都是运行时状态。

#### KV Cache 影响

不会直接失效；提供方不组装模型请求。

## 已知限制与延期工作

- **不会恢复非活动成员** — 投递会失败，等待会结束，而不是启动另一个进程或会话运行时。
