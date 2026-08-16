/**
 * Model-facing peer tool argument types.
 * @module @deepseek-ai/dsh-tool-peer/types
 */

import type { PeerWaitState } from '@deepseek-ai/dsh-peer'

/** Optional wait attached to `send_to_peer`; omission from the call means no wait. */
export interface SendToPeerWaitArgs {
  /** Execution states that may settle the delivery-correlated wait; defaults to idle or blocked. */
  readonly until?: readonly PeerWaitState[]
  /** Positive wait bound in milliseconds; deployment config supplies the default and cap. */
  readonly timeoutMs?: number
}

/** Arguments for one lateral peer delivery. */
export interface SendToPeerArgs {
  /** Active root session id or unique user-set title. */
  readonly peer: string
  /** Text delivered as an ordinary follow-up. */
  readonly message: string
  /** Optional delivery-correlated wait; absent returns after acceptance. */
  readonly wait?: SendToPeerWaitArgs
}

/** Arguments for a standalone state-based peer wait. */
export interface WaitForPeerArgs {
  /** Active root session id or unique user-set title. */
  readonly peer: string
  /** Matching execution states; defaults to idle or blocked. */
  readonly until?: readonly PeerWaitState[]
  /** Positive wait bound in milliseconds; deployment config supplies the default and cap. */
  readonly timeoutMs?: number
}

/** `list_peers` accepts no arguments. */
export type ListPeersArgs = Record<never, never>
