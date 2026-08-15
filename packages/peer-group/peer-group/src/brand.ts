/** Branded peer-group identity factories. @module @deepseek-ai/dsh-peer-group/brand */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one human-formed peer group. */
export type PeerGroupId = Branded<'PeerGroupId'>

/**
 * Brand a validated human-typed peer-group name.
 * @param value - exact validated group name.
 * @returns the same string with the peer-group brand.
 */
export function PeerGroupId(value: string): PeerGroupId {
  return value as PeerGroupId
}

/** Distinguishes repeated membership by the same session in one group. */
export type PeerMembershipIncarnation = Branded<'PeerMembershipIncarnation'>

/**
 * Brand one provider-minted membership incarnation.
 * @param value - provider-minted opaque value.
 * @returns the same string with the membership-incarnation brand.
 */
export function PeerMembershipIncarnation(value: string): PeerMembershipIncarnation {
  return value as PeerMembershipIncarnation
}

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
