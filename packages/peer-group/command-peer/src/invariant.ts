/** Package-owned invariant companion for the peer command Consumer. @module @deepseek-ai/dsh-command-peer/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-command-peer'

/** Cordis companion plugin name. */
export const name = 'command-peer-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the command registry owns invocation records and peerGroups owns membership state. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
