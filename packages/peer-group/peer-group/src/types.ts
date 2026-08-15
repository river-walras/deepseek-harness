/**
 * Public peer-group membership, delivery, and wait vocabulary.
 * @module @deepseek-ai/dsh-peer-group/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentWaitReason } from '@deepseek-ai/dsh-agent-wait'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  PeerDeliveryId,
  PeerGroupId,
  PeerMembershipIncarnation,
  PeerWaitId,
} from './brand.ts'

export type { PeerDeliveryId, PeerGroupId, PeerMembershipIncarnation, PeerWaitId } from './brand.ts'

/** Durable peer address; omission of `group` is valid only when resolution is unambiguous. */
export interface PeerRef {
  /** Group that qualifies membership and authority. */
  readonly group?: PeerGroupId
  /** Addressed root session. */
  readonly session: SessionId
}

/** Exact membership identity used for authorization and wait pinning. */
export interface PeerMembership {
  /** Owning group. */
  readonly groupId: PeerGroupId
  /** Enrolled root session. */
  readonly sessionId: SessionId
  /** Incarnation minted for this admission. */
  readonly incarnation: PeerMembershipIncarnation
}

/** Whether the enrolled root currently has an exact live Agent. */
export type PeerAvailability = 'live' | 'inactive'

/** Current execution state derived from Agent status and outstanding wait leases. */
export type PeerExecutionStatus =
  | { readonly state: 'working' }
  | { readonly state: 'idle' }
  | { readonly state: 'blocked'; readonly reason: AgentWaitReason }

/** Write classification enforced per canonical workspace during membership. */
export type PeerWriteAccess = 'write-capable' | 'read-only'

/** Human- and model-safe projection of one member without canonical workspace identity. */
export interface PeerMemberView extends PeerMembership {
  /** Current session title when one is available. */
  readonly title?: string
  /** Human-readable workspace label; never the canonical identity used by the guard. */
  readonly workspace?: string
  /** Whether the exact enrolled root is live. */
  readonly availability: PeerAvailability
  /** Current execution state when live; inactive members have no execution state. */
  readonly execution?: PeerExecutionStatus
  /** Current write classification used by the membership guard. */
  readonly writeAccess: PeerWriteAccess
}

/** Fresh projection of one group and its current memberships. */
export interface PeerGroupView {
  /** Registry-issued group identity. */
  readonly id: PeerGroupId
  /** Unique human-supplied group name. */
  readonly name: string
  /** Members in admission order. */
  readonly members: readonly PeerMemberView[]
}

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
  /** Exact live member installing the wait edge. */
  readonly caller: Agent
  /** Target resolved under the caller's memberships. */
  readonly peer: PeerRef
  /** Already-defaulted predicate and bound. */
  readonly wait: PeerWaitSpec
  /** Cancellation of this wait only. */
  readonly signal?: AbortSignal
}

/** Successful observation that settled a peer wait. */
export interface PeerWaitObservation {
  /** Installed graph-edge identity. */
  readonly waitId: PeerWaitId
  /** Membership identity pinned for the whole wait. */
  readonly peer: PeerMembership
  /** Matching execution state, including the blocked reason when applicable. */
  readonly execution: PeerExecutionStatus
}

/** Accepted delivery identity logged in the sender's tool result and target message source. */
export interface PeerDeliveryAcceptance {
  /** Peer delivery correlation id. */
  readonly deliveryId: PeerDeliveryId
  /** Exact inbox message id minted before follow-up delivery. */
  readonly messageId: MessageId
  /** Target membership authorized at delivery commit. */
  readonly peer: PeerMembership
}

/** Request for one lateral follow-up and optional delivery-correlated wait. */
export interface PeerSendRequest {
  /** Exact live member sending the message. */
  readonly caller: Agent
  /** Target resolved under the caller's memberships. */
  readonly peer: PeerRef
  /** Text delivered as an ordinary follow-up turn. */
  readonly message: string
  /** Optional already-defaulted bounded wait; omission returns after acceptance. */
  readonly wait?: PeerWaitSpec
  /** Cancellation of admission and any optional wait. */
  readonly signal?: AbortSignal
}

/** Delivery acceptance plus an optional observation tied to the claimed message turn. */
export interface PeerSendResult {
  /** Durable delivery correlation. */
  readonly delivery: PeerDeliveryAcceptance
  /** Present only when the request included a delivery-correlated wait. */
  readonly settled?: PeerWaitObservation & { readonly turn: number }
}

/** Stable error codes returned by peer-group operations. */
export type PeerGroupErrorCode =
  | 'BAD_GROUP_NAME'
  | 'GROUP_EXISTS'
  | 'GROUP_NOT_FOUND'
  | 'CALLER_NOT_LIVE'
  | 'CALLER_NOT_ROOT'
  | 'CALLER_NOT_MEMBER'
  | 'MEMBER_NOT_ROOT'
  | 'MEMBER_EXISTS'
  | 'MEMBER_NOT_FOUND'
  | 'PEER_AMBIGUOUS'
  | 'PEER_UNAVAILABLE'
  | 'PEER_BLOCKED_INTERACTION'
  | 'SECOND_WRITER'
  | 'WAIT_CYCLE'
  | 'WAIT_TIMEOUT'
  | 'PROMPT_STALLED'
  | 'WAIT_ABORTED'
  | 'MEMBERSHIP_REPLACED'
  | 'GROUP_DISSOLVED'
  | 'PROVIDER_DISPOSED'
  | 'SUBSCRIPTION_FAILED'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Informational record that a later policy change revoked this membership. */
    'peer-group/membership-removed': {
      readonly groupId: PeerGroupId
      readonly incarnation: PeerMembershipIncarnation
      readonly reason: 'second-writer'
    }
  }
}

/**
 * Durable attribution for a message accepted through peer delivery. The
 * service retains these fields but never treats them as authority; delivery
 * authorizes live membership, incarnation, and grant before acceptance.
 */
export interface PeerMessageSource {
  readonly kind: 'peer'
  readonly form: 'relay'
  /** Group recorded when delivery was authorized; this field carries no grant. */
  readonly groupId: PeerGroupId
  /** Sending member's session. */
  readonly senderSessionId: SessionId
  /** Sending membership incarnation authorized at delivery time. */
  readonly senderIncarnation: PeerMembershipIncarnation
  /** Correlation shared with the sender's delivery result. */
  readonly deliveryId: PeerDeliveryId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    peer: PeerMessageSource
  }
}
