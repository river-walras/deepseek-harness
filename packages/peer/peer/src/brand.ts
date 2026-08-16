/** Branded peer collaboration identity factories. @module @deepseek-ai/dsh-peer/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one accepted peer delivery. */
export type PeerDeliveryId = Branded<'PeerDeliveryId'>

/**
 * Brand one provider-minted delivery id.
 * @param value - provider-minted opaque value.
 * @returns the same string with the peer-delivery brand.
 */
export function PeerDeliveryId(value: string): PeerDeliveryId {
  return value as PeerDeliveryId
}

/** Identifies one installed wait-for-graph edge. */
export type PeerWaitId = Branded<'PeerWaitId'>

/**
 * Brand one provider-minted wait id.
 * @param value - provider-minted opaque value.
 * @returns the same string with the peer-wait brand.
 */
export function PeerWaitId(value: string): PeerWaitId {
  return value as PeerWaitId
}
