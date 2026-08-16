/**
 * Service Definition for zero-configuration collaboration between live root Agents.
 * @module @deepseek-ai/dsh-peer
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  PeerErrorCode,
  PeerSendRequest,
  PeerSendResult,
  PeerView,
  PeerWaitObservation,
  PeerWaitOptions,
  PeerWaitRequest,
  PeerWaitSpec,
} from './types.ts'

export * from './brand.ts'
export type * from './types.ts'

/** Stable peer operation failure. */
export class PeerError extends HarnessError {
  declare readonly code: PeerErrorCode

  /** Create one failure with a caller-visible stable code. */
  constructor(message: string, code: PeerErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'PeerError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    peers: PeerRegistry
  }
}

/**
 * Abstract registry for active-root discovery, lateral delivery, and bounded waits.
 *
 * Root status is the process-local authorization relation. It is not tenant
 * isolation: every live root in one single-user process can address every other
 * live root, including ACP, SDK, and UI roots.
 */
export abstract class PeerRegistry extends Service {
  constructor(ctx: Context) {
    super(ctx, 'peers')
  }

  /**
   * Resolve optional wait fields against the provider's validated timeout configuration.
   * @param options - optional predicate and timeout from a Consumer input.
   * @returns a non-empty predicate and bounded timeout accepted by operations.
   */
  abstract resolveWait(options?: PeerWaitOptions): PeerWaitSpec

  /**
   * List every other active root after revalidating the exact caller as a root.
   * @param caller - exact root requesting discovery.
   * @returns fresh peer projections in root registration order.
   */
  abstract list(caller: Agent): readonly PeerView[]

  /**
   * Resolve one peer once, authorize, and either dispatch its recognized command or enqueue a follow-up.
   * @param request - caller, peer address, line, optional resolved wait, and cancellation.
   * @returns command dispatch or durable message acceptance, plus any requested observation.
   */
  abstract send(request: PeerSendRequest): Promise<PeerSendResult>

  /**
   * Resolve one peer once, install a process-wide cycle-checked wait edge, and observe its state.
   * @param request - caller, peer address, resolved bounded predicate, and cancellation.
   * @returns the matching state of the exact resolved Agent generation.
   */
  abstract wait(request: PeerWaitRequest): Promise<PeerWaitObservation>
}

export default PeerRegistry
