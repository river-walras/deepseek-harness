/**
 * Public root-peer discovery, delivery, and wait types.
 * @module @deepseek-ai/dsh-peer/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentWaitReason } from '@deepseek-ai/dsh-agent-wait'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PeerDeliveryId, PeerWaitId } from './brand.ts'

export type { PeerDeliveryId, PeerWaitId } from './brand.ts'

/** Current execution state derived from Agent status and outstanding wait leases. */
export type PeerExecutionStatus =
  | { readonly state: 'working' }
  | { readonly state: 'idle' }
  | { readonly state: 'blocked'; readonly reason: AgentWaitReason }

/** Current write classification reported for peer coordination. */
export type PeerWriteAccess = 'write-capable' | 'read-only'

/** Provenance of a displayed title; only user titles are peer addresses. */
export type PeerTitleSource = 'user' | 'automatic'

/** Current model-safe projection of one active root peer. */
export type PeerView = {
  /** Root session identity and canonical peer address. */
  readonly sessionId: SessionId
  /** Human-readable workspace label; never the provider-private canonical identity. */
  readonly workspace?: string
  /** Preset the root currently runs, when one is selected. */
  readonly preset?: string
  /** Current execution state. */
  readonly execution: PeerExecutionStatus
  /**
   * Whether this peer can currently modify files. A root counts as `read-only`
   * only while it holds both `read-only` sandbox mode and the `never` approval
   * policy, because either alone leaves per-call escalation reachable.
   */
  readonly writeAccess: PeerWriteAccess
  /**
   * Present when this peer and the listing caller can both write one shared
   * workspace, so concurrent edits would collide. Advisory only: delivery is
   * never refused for it.
   */
  readonly sharesWritableWorkspace?: true
} & (
  | {
    /** Latest durable session title. */
    readonly title: string
    /** Whether the title is user-set and addressable or automatically generated for display. */
    readonly titleSource: PeerTitleSource
  }
  | {
    /** Absent before the session has a durable title. */
    readonly title?: never
    /** Absent when no title exists. */
    readonly titleSource?: never
  }
)

/** State predicates accepted by peer waits. */
export type PeerWaitState = 'working' | 'idle' | 'blocked'

/** Optional wait fields resolved by the provider before an operation starts. */
export interface PeerWaitOptions {
  /** Requested matching states; omission resolves to `idle | blocked`. */
  readonly until?: readonly PeerWaitState[]
  /** Requested timeout; omission resolves to the configured default. */
  readonly timeoutMs?: number
}

/** Fully resolved bounded wait supplied to the registry. */
export interface PeerWaitSpec {
  /** Non-empty set of execution states that settle the wait. */
  readonly until: readonly [PeerWaitState, ...PeerWaitState[]]
  /** Positive finite bound in milliseconds. */
  readonly timeoutMs: number
}

/** Request for a state-based standalone peer wait. */
export interface PeerWaitRequest {
  /** Exact live root installing the wait edge. */
  readonly caller: Agent
  /** Active root session id or unique user-set title. */
  readonly peer: string
  /** Already-defaulted predicate and bound. */
  readonly wait: PeerWaitSpec
  /** Cancellation of this wait only. */
  readonly signal?: AbortSignal
}

/** Successful observation that settled a peer wait. */
export interface PeerWaitObservation {
  /** Installed graph-edge identity. */
  readonly waitId: PeerWaitId
  /** Exact target session resolved when the wait began. */
  readonly peerSessionId: SessionId
  /** Matching execution state, including the blocked reason when applicable. */
  readonly execution: PeerExecutionStatus
}

/** Accepted delivery identity logged in the sender's tool result and target message source. */
export interface PeerDeliveryAcceptance {
  /** Peer delivery correlation id. */
  readonly deliveryId: PeerDeliveryId
  /** Exact inbox message id minted before follow-up delivery. */
  readonly messageId: MessageId
  /** Exact target session resolved for this delivery. */
  readonly peerSessionId: SessionId
  /**
   * Present when sender and target can both write one shared workspace, so
   * concurrent edits would collide. Advisory only: the delivery was accepted.
   */
  readonly sharesWritableWorkspace?: true
}

/** Outcome of a line the target's command plane recognized and ran. */
export interface PeerCommandExecution {
  /** Exact target session that ran the command. */
  readonly peerSessionId: SessionId
  /** Parsed command name, without the leading slash. */
  readonly name: string
  /** Whether the handler settled successfully. */
  readonly ok: boolean
  /** Handler text, when it returned any. */
  readonly text?: string
}

/** Request for one lateral line and optional wait. */
export interface PeerSendRequest {
  /** Exact live root sending the line. */
  readonly caller: Agent
  /** Active root session id or unique user-set title. */
  readonly peer: string
  /**
   * The line delivered to the target. A slash line the target's command plane
   * recognizes runs there as that command, matching what a human typing it
   * into that session would get; anything else becomes an ordinary follow-up
   * turn.
   */
  readonly message: string
  /** Optional already-defaulted bounded wait; omission returns after acceptance. */
  readonly wait?: PeerWaitSpec
  /** Cancellation of admission and any optional wait. */
  readonly signal?: AbortSignal
}

/**
 * What one line did at the target. Switch on `kind`: a `message` carries
 * delivery correlation and may carry an observation tied to its own claimed
 * turn, while a `command` ran in the target's command plane and produced no
 * inbox message, so any requested wait is state-based instead.
 */
export type PeerSendResult =
  | {
    readonly kind: 'message'
    /** Durable delivery correlation. */
    readonly delivery: PeerDeliveryAcceptance
    /** Present only when the request included a wait; tied to the claimed message turn. */
    readonly settled?: PeerWaitObservation & { readonly turn: number }
  }
  | {
    readonly kind: 'command'
    /** Lifecycle outcome reported by the target's command plane. */
    readonly command: PeerCommandExecution
    /** Present only when the request included a wait; state-based, uncorrelated. */
    readonly settled?: PeerWaitObservation
  }

/** Stable error codes returned by peer operations. */
export type PeerErrorCode =
  | 'CALLER_NOT_LIVE'
  | 'CALLER_NOT_ROOT'
  | 'AMBIGUOUS_PEER'
  | 'PEER_NOT_FOUND'
  | 'SELF_PEER'
  | 'PEER_UNAVAILABLE'
  | 'PEER_REPLACED'
  | 'PEER_BLOCKED_INTERACTION'
  | 'PEER_ARCHIVED'
  | 'WAIT_CYCLE'
  | 'WAIT_TIMEOUT'
  | 'PROMPT_STALLED'
  | 'WAIT_ABORTED'
  | 'PROVIDER_DISPOSED'
  | 'SUBSCRIPTION_FAILED'

/** Durable attribution for a message accepted through peer delivery. */
export interface PeerMessageSource {
  readonly kind: 'peer'
  readonly form: 'relay'
  /** Sending root session. */
  readonly senderSessionId: SessionId
  /** Correlation shared with the sender's delivery result. */
  readonly deliveryId: PeerDeliveryId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    peer: PeerMessageSource
  }
}
