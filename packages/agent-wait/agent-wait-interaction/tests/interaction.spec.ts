import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import * as AgentWaitInteraction from '@deepseek-ai/dsh-agent-wait-interaction'
import LocalAgentWaitRegistry from '@deepseek-ai/dsh-agent-wait-local'
import { SessionId, SessionStore, type Session } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import UserQuestionService, { type AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'

function stubAgent(id: ReturnType<typeof SessionId>, session: Session): Agent {
  return { id, session } as unknown as Agent
}

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  disposeAgent: () => void
  interactionFiber: Fiber
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalAgentWaitRegistry, { retainedTransitionLimit: 32 })
  await ctx.plugin(UserQuestionService)
  const interactionFiber = ctx.plugin(AgentWaitInteraction)
  await interactionFiber
  const id = SessionId('interaction-agent')
  const agent = stubAgent(id, ctx.sessions.create(id))
  const disposeAgent = ctx.agents.register(agent)
  return { ctx, agent, disposeAgent, interactionFiber }
}

function answer(): AskUserQuestionAnswer {
  return { answers: [{ id: 'confirm', selected: ['yes'] }] }
}

describe('agent-wait interaction Consumer', () => {
  it('acquires and releases around an immediately fulfilled provider promise', async () => {
    const { ctx, agent } = await harness()
    const before = ctx.agentWaits.snapshot().cursor
    ctx.userQuestions.registerProvider({ ask: async () => answer() })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent,
    })).resolves.toEqual(answer())

    const read = ctx.agentWaits.changes(before)
    expect(read.kind === 'changes' ? read.transitions.map(transition => transition.kind) : [])
      .toEqual(['acquired', 'ended'])
    expect(ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('holds a question lease through asynchronous fulfillment', async () => {
    const { ctx, agent } = await harness()
    const pending = Promise.withResolvers<AskUserQuestionAnswer>()
    ctx.userQuestions.registerProvider({ ask: () => pending.promise })

    const asked = ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent,
    })
    expect(ctx.agentWaits.snapshot().leases).toMatchObject([{
      sessionId: agent.id,
      reason: 'interaction',
    }])

    pending.resolve(answer())
    await expect(asked).resolves.toEqual(answer())
    expect(ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('releases a question lease when the provider rejects', async () => {
    const { ctx, agent } = await harness()
    const pending = Promise.withResolvers<AskUserQuestionAnswer>()
    ctx.userQuestions.registerProvider({ ask: () => pending.promise })

    const asked = ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent,
    })
    expect(ctx.agentWaits.snapshot().leases).toHaveLength(1)
    pending.reject(new Error('provider failed'))

    await expect(asked).rejects.toThrow('provider failed')
    expect(ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('releases a question lease after a post-dispatch abort settles the provider', async () => {
    const { ctx, agent } = await harness()
    const controller = new AbortController()
    ctx.userQuestions.registerProvider({
      ask: request => new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => {
          const reason: unknown = request.signal?.reason
          reject(reason instanceof Error ? reason : new Error(String(reason)))
        }, { once: true })
      }),
    })

    const asked = ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent,
      signal: controller.signal,
    })
    expect(ctx.agentWaits.snapshot().leases).toHaveLength(1)
    controller.abort(new Error('withdrawn'))

    await expect(asked).rejects.toThrow('withdrawn')
    expect(ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('does not acquire a lease for an agentless provider dispatch', async () => {
    const { ctx } = await harness()
    const pending = Promise.withResolvers<AskUserQuestionAnswer>()
    ctx.userQuestions.registerProvider({ ask: () => pending.promise })

    const asked = ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] })
    expect(ctx.agentWaits.snapshot().leases).toEqual([])
    pending.resolve(answer())
    await asked
  })

  it('pairs approval audit events and retains an unmatched ask until its agent ends', async () => {
    const { ctx, agent, disposeAgent } = await harness()
    const paired = ApprovalRequestId('paired')
    agent.session.append('approval/asked', { id: paired, toolName: 'bash' })
    expect(ctx.agentWaits.snapshot().leases).toMatchObject([{
      sessionId: agent.id,
      reason: 'interaction',
    }])

    agent.session.append('approval/decided', { id: paired, outcome: 'allowed-once' })
    expect(ctx.agentWaits.snapshot().leases).toEqual([])

    agent.session.append('approval/asked', { id: ApprovalRequestId('unmatched'), toolName: 'bash' })
    expect(ctx.agentWaits.snapshot().leases).toHaveLength(1)
    disposeAgent()
    expect(ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('releases unmatched approval and question leases when the Consumer unloads', async () => {
    const { ctx, agent, interactionFiber } = await harness()
    const pending = Promise.withResolvers<AskUserQuestionAnswer>()
    ctx.userQuestions.registerProvider({ ask: () => pending.promise })
    const asked = ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent,
    })
    agent.session.append('approval/asked', { id: ApprovalRequestId('open'), toolName: 'bash' })
    expect(ctx.agentWaits.snapshot().leases).toHaveLength(2)

    await interactionFiber.dispose()

    expect(ctx.agentWaits.snapshot().leases).toEqual([])
    pending.resolve(answer())
    await asked
  })
})
