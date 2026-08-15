/** Package-owned invariant companion for interaction wait derivation. @module @deepseek-ai/dsh-agent-wait-interaction/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-wait-interaction'

/** Cordis companion plugin name. */
export const name = 'agent-wait-interaction-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: source interaction packages own their lifecycles and the registry owns lease state. */
const install: InvariantInstaller = () => {}

/**
 * Register the intentionally empty invariant contribution.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
