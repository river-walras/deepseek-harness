/**
 * Process-local wait identifiers owned by `@deepseek-ai/dsh-agent-wait`.
 * @module @deepseek-ai/dsh-agent-wait/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identifies one process lifetime so revision counters never imply cross-restart continuity. */
export type AgentWaitEpoch = Branded<'AgentWaitEpoch'>

/**
 * Brand a process-lifetime identifier as an {@link AgentWaitEpoch}.
 * @param value - raw process-lifetime identifier.
 * @returns the same string carrying the epoch brand.
 */
export function AgentWaitEpoch(value: string): AgentWaitEpoch {
  return value as AgentWaitEpoch
}

/** Identifies one wait lease within its process epoch. */
export type AgentWaitLeaseId = Branded<'AgentWaitLeaseId'>

/**
 * Brand a registry-issued identifier as an {@link AgentWaitLeaseId}.
 * @param value - raw lease identifier.
 * @returns the same string carrying the lease brand.
 */
export function AgentWaitLeaseId(value: string): AgentWaitLeaseId {
  return value as AgentWaitLeaseId
}
