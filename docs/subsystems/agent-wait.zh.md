# Agent 等待观察

[English](agent-wait.md) | 中文

[`@deepseek-ai/dsh-agent-wait`](../../packages/agent-wait/agent-wait) Service Definition 发布会话无法继续执行的临时原因。它让 `AgentStatus` 保持为 `idle | running`，不添加会话事件，并向可信运行时消费方提供一种可检测缺口的观察协议。

源文件：[`packages/agent-wait/agent-wait/src/index.ts`](../../packages/agent-wait/agent-wait/src/index.ts) 和 [`types.ts`](../../packages/agent-wait/agent-wait/src/types.ts)

## 租约身份与原因

每个租约都有一个 `AgentWaitLeaseId`、一个所属 `SessionId`，以及 `interaction | peer` 原因。`interaction` 等待表示审批或用户问题尚未结算；`peer` 等待表示 agent（智能体）正在等待同级 agent 组中的另一名成员。一个会话可以同时有多个租约。

精确的进程内 `Agent` 拥有确定性释放：显式释放和 Agent dispose（资源释放）都会令租约以 `released` 结束。外部会话观察带有正数超时；没有确定性所有者释放时，它以 `observation-timeout` 结束。快照只公开会话身份和生命周期种类，绝不公开实时 `Agent` 对象。

```ts check
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

type AgentWaitReason = 'interaction' | 'peer'

type AgentWaitLeaseLifetime =
  | { readonly kind: 'agent'; readonly agent: Agent }
  | { readonly kind: 'observation'; readonly sessionId: SessionId; readonly timeoutMs: number }

type AgentWaitTermination = 'released' | 'observation-timeout'
```

## 带修订号的观察

一个进程 epoch 限定一个单调修订号计数器。`snapshot()` 先读取修订号、构建新的活动租约投影视图、再次读取修订号，并在值已变化时重试。因此，重启会产生新的 epoch，不会让修订号零看似延续上一个进程。

消费方先获取快照、注册 `onChanged`，再调用 `changes(snapshot.cursor)`，然后才依赖后续通知，以闭合快照与订阅之间的竞态。保留的转换优先于新快照，因为快照可能抹去一段完整的 `acquired → ended` 区间。当保留历史无法衔接游标时，`changes()` 返回带 `epoch-changed` 或 `revision-gap` 的 `refresh`。

```ts check
import type {
  AgentWaitEpoch,
  AgentWaitSnapshot,
  AgentWaitTransition,
} from '@deepseek-ai/dsh-agent-wait'

interface AgentWaitCursor {
  readonly epoch: AgentWaitEpoch
  readonly revision: number
}

type AgentWaitChangeRead =
  | {
    readonly kind: 'changes'
    readonly after: AgentWaitCursor
    readonly cursor: AgentWaitCursor
    readonly transitions: readonly AgentWaitTransition[]
  }
  | {
    readonly kind: 'refresh'
    readonly reason: 'epoch-changed' | 'revision-gap'
    readonly snapshot: AgentWaitSnapshot
  }
```

## 交互派发

[`user-questions/provider-dispatch`](../../packages/interaction/user-questions/src/index.ts) 生命周期事件在请求验证和提供方选择之后、`provider.ask()` 之前运行，并在提供方结算后 dispose 延后的单次调用资源。派发前的 `ASK_ABORTED`、`CALLER_NOT_LIVE`、`DELEGATED_CALLER`、`EMPTY_QUESTIONS`、`BAD_INTENT` 和 `NO_PROVIDER` 失败不会发出事件，也不会发布转换。提供方速度不改变原因，也不会引入时间截止点。

审批等待从现有 `approval/asked` 与 `approval/decided` 事件对派生。两种交互来源都进入同一个进程内注册表，而不添加持久等待事件；模型可见消费方在自己的工具结果中记录观察结果。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentwaits--agentwaitregistry-abstract-seam"></a>

### `ctx.agentWaits` — `AgentWaitRegistry` (abstract seam)

Abstract registry of ephemeral reasons agents are waiting.

Implementations keep one process epoch and a monotonic revision. Snapshot reads use a revision/snapshot/revision retry, while subscribers drain retained transitions after registering so complete transient waits win over a later snapshot. A retention gap returns a replacement snapshot.

```ts cordis-catalog
/**
 * Publish an outstanding wait owned by an exact agent or bounded observation.
 * @param request - Wait reason and lifetime owner.
 * @returns the idempotent deterministic-release handle.
 */
abstract acquire(request: AgentWaitAcquireRequest): AgentWaitLease

/**
 * Read a revision-stable projection of every active lease.
 * @returns a fresh immutable snapshot and its process cursor.
 */
abstract snapshot(): AgentWaitSnapshot

/**
 * Read the complete retained suffix after a cursor, or require refresh when
 * the process epoch changed or the caller fell behind retention.
 * @param after - Last cursor fully processed by the observer.
 * @returns retained transitions or a consistent replacement snapshot.
 */
abstract changes(after: AgentWaitCursor): AgentWaitChangeRead

/**
 * Register an effect-scoped, failure-contained change notification. A consumer closes the
 * snapshot/subscribe race by registering, then calling {@link changes} from
 * its snapshot cursor before relying on notifications.
 * @param listener - Notification carrying the latest committed cursor; throws and rejections are contained.
 * @returns disposer that unregisters the listener.
 */
abstract onChanged(listener: AgentWaitChangedListener): () => void
```

Source: [`packages/agent-wait/agent-wait/src/index.ts:33`](../../packages/agent-wait/agent-wait/src/index.ts)
<!-- END GENERATED cordis-surface -->
