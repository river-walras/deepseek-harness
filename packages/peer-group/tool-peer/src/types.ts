/**
 * Model-facing peer tool argument vocabulary.
 * @module @deepseek-ai/dsh-tool-peer/types
 */

import type { PeerGroupId, PeerRef, PeerWaitState } from '@deepseek-ai/dsh-peer-group'

/** Optional wait attached to `send_to_peer`; omission from the call means no wait. */
export interface SendToPeerWaitArgs {
  /** Execution states that may settle the delivery-correlated wait; defaults to idle or blocked. */
  readonly until?: readonly PeerWaitState[]
  /** Positive wait bound in milliseconds; deployment config supplies the default and cap. */
  readonly timeoutMs?: number
}

/** Arguments for one lateral peer delivery. */
export interface SendToPeerArgs {
  /** Target session, group-qualified when the caller shares several groups with it. */
  readonly peer: PeerRef
  /** Text delivered as an ordinary follow-up. */
  readonly message: string
  /** Optional delivery-correlated wait; absent returns after acceptance. */
  readonly wait?: SendToPeerWaitArgs
}

/** Arguments for a standalone state-based peer wait. */
export interface WaitForPeerArgs {
  /** Target session, group-qualified when needed for unambiguous authority. */
  readonly peer: PeerRef
  /** Matching execution states; defaults to idle or blocked. */
  readonly until?: readonly PeerWaitState[]
  /** Positive wait bound in milliseconds; deployment config supplies the default and cap. */
  readonly timeoutMs?: number
}

/** Arguments for listing visible groups or one peer. */
export type ListPeersArgs =
  | { readonly group?: PeerGroupId; readonly peer?: never }
  | { readonly group?: never; readonly peer: PeerRef }
