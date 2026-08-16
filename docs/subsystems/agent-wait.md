# Agent Wait Observation

English | [中文](agent-wait.zh.md)

The [`@deepseek-ai/dsh-agent-wait`](../../packages/agent-wait/agent-wait) Service Definition publishes ephemeral reasons a session cannot continue. It leaves `AgentStatus` as `idle | running`, adds no session event, and gives trusted runtime Consumers one gap-aware observation protocol.

Source: [`packages/agent-wait/agent-wait/src/index.ts`](../../packages/agent-wait/agent-wait/src/index.ts) and [`types.ts`](../../packages/agent-wait/agent-wait/src/types.ts)

## Lease identity and reasons

Each lease has an `AgentWaitLeaseId`, one owning `SessionId`, and reason `interaction | peer`. An `interaction` wait means an approval or user question is outstanding; a `peer` wait means the agent is waiting on another live root. Several leases may coexist for one session.

An exact in-process `Agent` owns deterministic release: explicit release and Agent disposal end the lease as `released`. A foreign-session observation carries a positive timeout and ends as `observation-timeout` if no deterministic owner releases it. Snapshots expose only session identity and lifetime kind, never the live `Agent` object.

```ts check
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

type AgentWaitReason = 'interaction' | 'peer'

type AgentWaitLeaseLifetime =
  | { readonly kind: 'agent'; readonly agent: Agent }
  | { readonly kind: 'observation'; readonly sessionId: SessionId; readonly timeoutMs: number }

type AgentWaitTermination = 'released' | 'observation-timeout'
```

## Revisioned observation

One process epoch qualifies a monotonic revision counter. `snapshot()` reads revision, constructs a fresh active-lease projection, reads revision again, and retries when the value moved. A restart therefore produces a new epoch instead of making revision zero appear continuous with the prior process.

Consumers close the snapshot/subscribe race by taking a snapshot, registering `onChanged`, then calling `changes(snapshot.cursor)` before depending on later notifications. Retained transitions are preferred over a new snapshot because a snapshot can erase a complete `acquired → ended` interval. `changes()` returns `refresh` with `epoch-changed` or `revision-gap` when retained history cannot bridge the cursor.

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

## Interaction dispatch

The [`user-questions/provider-dispatch`](../../packages/interaction/user-questions/src/index.ts) lifecycle event runs after request validation and provider selection, immediately before `provider.ask()`, and disposes deferred per-call resources after the provider settles. Pre-dispatch `ASK_ABORTED`, `CALLER_NOT_LIVE`, `DELEGATED_CALLER`, `EMPTY_QUESTIONS`, `BAD_INTENT`, and `NO_PROVIDER` failures emit nothing and publish no transition. Provider speed does not change the reason or introduce a timing cutoff.

Approval waits derive from the existing `approval/asked` and `approval/decided` event pair. Both interaction sources feed the same process-local registry without adding a durable wait event; a model-visible Consumer logs the observation in its own tool result.

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
