/**
 * Interaction-lifecycle Consumer for `ctx.agentWaits`.
 * @module @deepseek-ai/dsh-agent-wait-interaction
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { AgentWaitLease } from '@deepseek-ai/dsh-agent-wait'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'

/** Cordis plugin name. */
export const name = 'agent-wait-interaction'

/** Services required for exact-agent wait ownership. */
export const inject = ['agents', 'agentWaits']

/**
 * Derive `interaction` leases from live user-question and approval lifecycles.
 * @param ctx - Context carrying the live Agent and wait registries.
 */
export function apply(ctx: Context): void {
  const questionLeases = new Set<AgentWaitLease>()
  const approvalLeases = new Map<Session, Map<ApprovalRequestId, AgentWaitLease>>()

  const releaseApprovals = (session: Session): void => {
    const pending = approvalLeases.get(session)
    if (pending === undefined) return
    approvalLeases.delete(session)
    for (const lease of pending.values()) lease.release()
  }

  ctx.effect(() => () => {
    for (const lease of questionLeases) lease.release()
    questionLeases.clear()
    for (const session of [...approvalLeases.keys()]) releaseApprovals(session)
  }, 'agentWaitInteraction.releaseLeases()')

  ctx.on('user-questions/provider-dispatch', (lifecycle) => {
    const agent = lifecycle.request.agent
    if (agent === undefined) return
    const lease = ctx.agentWaits.acquire({ lifetime: { kind: 'agent', agent }, reason: 'interaction' })
    questionLeases.add(lease)
    lifecycle.defer(() => {
      questionLeases.delete(lease)
      lease.release()
    })
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked') {
      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return
      let pending = approvalLeases.get(session)
      if (pending === undefined) {
        pending = new Map()
        approvalLeases.set(session, pending)
      }
      if (pending.has(event.data.id)) return
      pending.set(event.data.id, ctx.agentWaits.acquire({
        lifetime: { kind: 'agent', agent },
        reason: 'interaction',
      }))
      return
    }
    if (event.type !== 'approval/decided') return
    const pending = approvalLeases.get(session)
    if (pending === undefined) return
    const lease = pending.get(event.data.id)
    if (lease === undefined) return
    pending.delete(event.data.id)
    if (pending.size === 0) approvalLeases.delete(session)
    lease.release()
  })

  ctx.on('agent/disposed', ({ agent }) => {
    releaseApprovals(agent.session)
  })
}
