# @deepseek-ai/dsh-agent-wait-interaction

[English](README.md) | 中文

[`ctx.agentWaits`](../agent-wait/README.md) 的交互消费方包。它会在用户问题提供方派发期间获取 `interaction` 租约，并从现有的 `approval/asked` 和 `approval/decided` 事件派生相同原因，而不修改 `dsh-user-approval`。

问题租约仅在请求验证和提供方选择完成后、提供方调用之前开始，并在该调用结算后结束。派发前的 `ASK_ABORTED`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`、`EMPTY_QUESTIONS`、`BAD_INTENT` 和 `NO_PROVIDER` 失败不会发布转换。提供方的速度和身份不改变原因：每项未完成的审批或问题都是 `interaction` 等待。

对于不带精确 `Agent` 的请求，提供方派发仍会发出生命周期事件。该请求没有拥有等待的会话，因此消费方不会获取租约。

只有当 `approval/asked` 事件的 Session 属于精确的存活 `Agent` 时，该事件才会获取租约。带匹配 id 的 `approval/decided` 会释放租约。未匹配的提问会保持阻塞，直到后续匹配决定、精确 `Agent` dispose 或消费方 dispose；重复的活动提问 id 不会获取第二份租约。

## 模型体验

### 交互等待派生

#### 模型看到什么

不会直接看到来自 `interaction` 租约的任何内容；本包观察生命周期并且只发布进程内状态。

#### Token 影响

直接 token 为零；问题答案和审批结果仍归其现有消费方所有。

#### KV Cache 影响

不会直接失效；派生等待不会改变请求内容。

## 已知限制与延期工作

- **仅实时派生** — 恢复的审批审计历史不会重新创建等待租约；只有挂载该进程内消费方期间追加的生命周期事件才会形成当前等待状态。
