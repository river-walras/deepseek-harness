# @deepseek-ai/dsh-agent-wait-local

[English](README.md) | 中文

[`@deepseek-ai/dsh-agent-wait`](../agent-wait/README.md) 的进程内 Service Provider 包。它拥有活动租约、一个进程 epoch、单调修订号、保留的转换、精确 `Agent` 的 dispose（资源释放）、观察超时以及故障隔离的变化通知。

`retainedTransitionLimit` 是必填的正整数 Cordis 配置字段，用于限制追赶所需的转换后缀；它没有隐式部署默认值。早于保留下限的游标会收到带替换快照的 `revision-gap`。`snapshot()` 会在投影期间修订号发生变化时重试，观察者失败无法否决转换或阻止后续观察者收到通知。

进程 epoch 在每个进程中只铸造一次。替换提供方会在该 epoch 内推进一道修订号屏障，因此来自已 dispose 提供方代际的游标会收到 `revision-gap`，而不会把空的替换状态视为连续状态。提供方 dispose 会清除计时器、活动记录、保留的转换和观察者。

## 模型体验

### 进程内提供方状态

#### 模型看到什么

不会直接看到来自 `ctx.agentWaits` 的任何内容；提供方向已注册消费方提供运行时观察结果。

#### Token 影响

直接 token 为零；提供方不拥有提示词、工具 schema 或渲染结果。

#### KV Cache 影响

不会直接失效；提供方状态位于模型请求组装之外。

## 已知限制与延期工作

- **没有持久恢复** — 活动租约和保留的转换会随进程 epoch 一起结束，这是有意行为。
