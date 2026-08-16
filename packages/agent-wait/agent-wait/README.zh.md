# @deepseek-ai/dsh-agent-wait

[English](README.md) | 中文

`ctx.agentWaits` 的 Service Definition；该进程内注册表记录 agent（智能体）正在等待的原因。它不改变 `AgentStatus`，并以可独立释放的租约表示每项未满足的依赖。

## 服务约定

- `acquire(request)` 发布 `interaction` 或 `peer` 租约。精确的实时 `Agent` 提供确定性清理；被观察的会话使用正数有界超时，若没有所有者释放，则以 `observation-timeout` 结束。
- `snapshot()` 返回一个进程 epoch、单调修订号和新的活动租约视图。实现先读取修订号、构建快照、再次读取修订号，并在修订号变化时重试。
- `changes(after)` 返回游标之后所有仍被保留的转换。epoch 变化或修订号缺口会返回替代快照，而不是静默跳过历史。
- `onChanged(listener)` 是受 effect 作用域约束的通知。消费方先注册、排空 `changes(snapshot.cursor)`，随后优先使用保留的转换而不是较晚快照，使一次完整的短暂等待仍可被观察。

租约是运行时观察结果，不是持久会话事实。本包不添加 `SessionEventMap` 成员。模型只会通过消费方已记录的工具结果看到等待。

参见 [agent-wait 子系统参考](../../../docs/subsystems/agent-wait.md)和拟议的[零配置同级协作设计](../../../.agents/notes/proposed/feature/2026-08-15-zero-setup-root-peer-collaboration.md)。

## 模型体验

### 运行时等待状态

#### 模型看到什么

不会直接看到来自 `ctx.agentWaits` 的任何内容；消费方决定是否把等待观察结果写入已记录的工具结果。

#### Token 影响

直接 token 为零；租约、游标和转换都是进程内运行时值。

#### KV Cache 影响

不会直接失效；注册表不组装或改变模型请求。

## 已知限制与延期工作

- **状态仅存在于进程内** — 进程重启会改变 epoch 并丢弃全部租约；跨进程提供方必须发布有界观察结果，不能暗示连续性。
- **提供方保留的转换数量有限** — 落后的订阅者可能收到 `revision-gap`，并且必须用返回的快照替换本地状态。
