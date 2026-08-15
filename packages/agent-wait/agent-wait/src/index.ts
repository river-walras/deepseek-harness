/**
 * Service Definition for process-local agent wait observation.
 * @module @deepseek-ai/dsh-agent-wait
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AgentWaitAcquireRequest,
  AgentWaitChangedListener,
  AgentWaitChangeRead,
  AgentWaitCursor,
  AgentWaitLease,
  AgentWaitSnapshot,
} from './types.ts'

export * from './brand.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentWaits: AgentWaitRegistry
  }
}

/**
 * Abstract registry of ephemeral reasons agents are waiting.
 *
 * Implementations keep one process epoch and a monotonic revision. Snapshot
 * reads use a revision/snapshot/revision retry, while subscribers drain
 * retained transitions after registering so complete transient waits win over
 * a later snapshot. A retention gap returns a replacement snapshot.
 */
export abstract class AgentWaitRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agentWaits')
  }

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
}

export default AgentWaitRegistry
