/**
 * Public wait-lease vocabulary for `ctx.agentWaits`.
 * @module @deepseek-ai/dsh-agent-wait/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentWaitEpoch, AgentWaitLeaseId } from './brand.ts'

export type { AgentWaitEpoch, AgentWaitLeaseId } from './brand.ts'

/** Why an agent is unable to continue its current work. */
export type AgentWaitReason = 'interaction' | 'peer'

/** Position in the process-local wait transition stream. */
export interface AgentWaitCursor {
  /** Process lifetime that owns the revision. */
  readonly epoch: AgentWaitEpoch
  /** Monotonic transition revision within the epoch. */
  readonly revision: number
}

/**
 * Lifetime owner for a wait lease.
 *
 * Exact live agents release deterministically on explicit disposal or agent
 * disposal. Observed sessions decay when their bounded observation expires.
 */
export type AgentWaitLeaseLifetime =
  | { readonly kind: 'agent'; readonly agent: Agent }
  | { readonly kind: 'observation'; readonly sessionId: SessionId; readonly timeoutMs: number }

/** Request to publish one outstanding wait. */
export interface AgentWaitAcquireRequest {
  /** Session lifetime that owns the lease. */
  readonly lifetime: AgentWaitLeaseLifetime
  /** Outstanding dependency represented by the lease. */
  readonly reason: AgentWaitReason
}

/** Immutable active-lease projection safe for observers. */
export interface AgentWaitLeaseView {
  /** Registry-issued identity. */
  readonly id: AgentWaitLeaseId
  /** Session whose execution is blocked. */
  readonly sessionId: SessionId
  /** Outstanding dependency represented by the lease. */
  readonly reason: AgentWaitReason
  /** Whether release is exact-agent-owned or observation-time-bounded. */
  readonly lifetime: AgentWaitLeaseLifetime['kind']
}

/** Consistent read of every active wait lease at one cursor. */
export interface AgentWaitSnapshot {
  /** Stream position represented by this snapshot. */
  readonly cursor: AgentWaitCursor
  /** Fresh immutable lease views in acquisition order. */
  readonly leases: readonly AgentWaitLeaseView[]
}

/** How an acquired lease stopped contributing wait state. */
export type AgentWaitTermination = 'released' | 'observation-timeout'

/** One committed transition in the process-local wait stream. */
export type AgentWaitTransition =
  | {
    readonly kind: 'acquired'
    readonly cursor: AgentWaitCursor
    readonly lease: AgentWaitLeaseView
  }
  | {
    readonly kind: 'ended'
    readonly cursor: AgentWaitCursor
    readonly lease: AgentWaitLeaseView
    readonly termination: AgentWaitTermination
  }

/** Catch-up result after a previously observed cursor. */
export type AgentWaitChangeRead =
  | {
    readonly kind: 'changes'
    /** Cursor supplied by the observer. */
    readonly after: AgentWaitCursor
    /** Current stream cursor after applying every returned transition. */
    readonly cursor: AgentWaitCursor
    /** Complete retained transition suffix, in revision order. */
    readonly transitions: readonly AgentWaitTransition[]
  }
  | {
    readonly kind: 'refresh'
    /** Why retained transitions cannot bridge the supplied cursor. */
    readonly reason: 'epoch-changed' | 'revision-gap'
    /** Consistent replacement state. */
    readonly snapshot: AgentWaitSnapshot
  }

/** Handle held by the operation that owns an outstanding wait. */
export interface AgentWaitLease {
  /** Registry-issued identity. */
  readonly id: AgentWaitLeaseId
  /**
   * End the lease deterministically; repeated calls are harmless.
   */
  release(): void
}

/** Notification that observers can use to drain retained transitions; returned promises are observed, not awaited. */
export type AgentWaitChangedListener = (cursor: AgentWaitCursor) => void | PromiseLike<void>
