/**
 * Service Definition for human-formed lateral collaboration between root Agents.
 * @module @deepseek-ai/dsh-peer-group
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  PeerGroupErrorCode,
  PeerGroupId,
  PeerGroupView,
  PeerMemberView,
  PeerSendRequest,
  PeerSendResult,
  PeerWaitObservation,
  PeerWaitOptions,
  PeerWaitRequest,
  PeerWaitSpec,
} from './types.ts'

export * from './brand.ts'
export type * from './types.ts'

/** Stable peer-group operation failure. */
export class PeerGroupError extends HarnessError {
  declare readonly code: PeerGroupErrorCode

  /** Create one failure with a caller-visible stable code. */
  constructor(message: string, code: PeerGroupErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PeerGroupError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    peerGroups: PeerGroupRegistry
  }
}

/**
 * Abstract registry for peer membership, authority, delivery, and bounded waits.
 *
 * Membership operations admit exact live roots and are exposed only through
 * the human command Consumer. Model-facing Consumers may list and use an
 * existing membership but cannot create, add, remove, or dissolve it.
 */
export abstract class PeerGroupRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'peerGroups')
  }

  /**
   * Resolve optional wait fields against the provider's validated timeout
   * configuration.
   * @param options - optional predicate and timeout from a Consumer boundary.
   * @returns a non-empty predicate and bounded timeout accepted by operations.
   */
  abstract resolveWait(options?: PeerWaitOptions): PeerWaitSpec

  /**
   * Create a named group and enroll the invoking live root as its first member.
   * @param caller - exact root receiving the human command.
   * @param name - unique non-empty group name.
   * @returns the new group projection.
   */
  abstract create(caller: Agent, name: string): Promise<PeerGroupView>

  /**
   * Enroll an existing exact live root after workspace write admission.
   * @param caller - exact member receiving the human command.
   * @param groupId - group to change.
   * @param sessionId - existing root session to enroll.
   * @returns the admitted membership projection.
   */
  abstract add(caller: Agent, groupId: PeerGroupId, sessionId: SessionId): Promise<PeerMemberView>

  /**
   * Revoke one membership and terminate every wait pinned to its incarnation.
   * @param caller - exact member receiving the human command.
   * @param groupId - group to change.
   * @param sessionId - enrolled session to remove.
   */
  abstract remove(caller: Agent, groupId: PeerGroupId, sessionId: SessionId): Promise<void>

  /**
   * Dissolve a group, revoke every grant, and terminate its waits.
   * @param caller - exact member receiving the human command.
   * @param groupId - group to dissolve.
   */
  abstract dissolve(caller: Agent, groupId: PeerGroupId): Promise<void>

  /**
   * List groups visible to an exact member, optionally narrowing by id.
   * @param caller - reading live member.
   * @param groupId - optional exact group.
   * @returns fresh projections without canonical workspace identities.
   */
  abstract list(caller: Agent, groupId?: PeerGroupId): readonly PeerGroupView[]

  /**
   * Authorize and enqueue one ordinary peer follow-up, optionally waiting for
   * the exact claimed message turn to reach a requested state.
   * @param request - caller, peer address, message, optional resolved wait, and cancellation.
   * @returns durable acceptance and optional delivery-correlated observation.
   */
  abstract send(request: PeerSendRequest): Promise<PeerSendResult>

  /**
   * Install a cycle-checked standalone wait edge and observe the target state.
   * @param request - caller, peer address, resolved bounded predicate, and cancellation.
   * @returns the matching state for the pinned membership incarnation.
   */
  abstract wait(request: PeerWaitRequest): Promise<PeerWaitObservation>
}

export default PeerGroupRegistry
