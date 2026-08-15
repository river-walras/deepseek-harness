import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import UserQuestionService, {
  UserQuestionError,
  type AskUserQuestionRequest,
  type UserQuestionProvider,
} from '@deepseek-ai/dsh-user-questions'

function provider(answer = 'approved'): UserQuestionProvider & { seen: AskUserQuestionRequest[] } {
  const seen: AskUserQuestionRequest[] = []
  return {
    seen,
    async ask(request) {
      seen.push(request)
      return { answers: [{ id: request.questions[0]?.id ?? 'missing', selected: [answer] }] }
    },
  }
}

function stubAgent(id: string, delegationDepth = 0): Agent {
  const agentId = id as Agent['id']
  return {
    id: agentId,
    session: { id: agentId, header: { delegationDepth } },
  } as unknown as Agent
}

describe('UserQuestionService', () => {
  it('delegates ask requests to the registered provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider('yes')
    ctx.userQuestions.registerProvider(p)

    const result = await ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
    expect(p.seen).toEqual([{ questions: [{ id: 'confirm', question: 'Proceed?' }] }])
  })

  it('rejects ask requests when no provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
  })

  it('registers providers with HMR-safe disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider()
    const dispose = ctx.userQuestions.registerProvider(p)

    dispose()
    dispose()

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('rejects duplicate providers instead of replacing the active UI', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    ctx.userQuestions.registerProvider(provider('first'))

    expect(() => ctx.userQuestions.registerProvider(provider('second')))
      .toThrow(UserQuestionError)
  })

  it('fails before reaching the provider when the signal is already aborted', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [{ id: 'confirm', selected: ['too late'] }] })) }
    ctx.userQuestions.registerProvider(p)
    const controller = new AbortController()
    controller.abort()

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }], signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects empty question batches before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)

    await expect(ctx.userQuestions.ask({ questions: [] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'EMPTY_QUESTIONS' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a live runtime-owned agent before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)
    const root = stubAgent('root', 0)
    const child = stubAgent('child', 0)
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: child,
    })).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'DELEGATED_CALLER',
      message: "human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result",
    })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('reaches the provider for a lineage-bearing session resumed as a runtime root', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = provider('yes')
    ctx.userQuestions.registerProvider(p)
    const agent = stubAgent('resumed-root', 1)
    ctx.agents.enter(agent, undefined)

    const result = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent,
    })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
  })

  it('rejects a supplied agent when no live registry can attest it', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('unattested'),
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'CALLER_NOT_LIVE' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a stale agent object that reuses a live id', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)
    const live = stubAgent('same-id')
    ctx.agents.enter(live, undefined)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('same-id'),
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'CALLER_NOT_LIVE' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects an intent whose approve label names none of its own options', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)
    const question = { id: 'plan-review', question: 'Approve?', detail: '# Plan' }

    // A wrong label among offered options, and no options offered at all.
    for (const options of [[{ label: 'Approve' }], undefined]) {
      await expect(ctx.userQuestions.ask({
        questions: [{
          ...question,
          ...(options === undefined ? {} : { options }),
          intent: { kind: 'plan-review', approve: 'Ship it' },
        }],
      })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'BAD_INTENT' })
    }
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a plan-review intent on a question carrying no plan to review', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)

    // Detail IS the plan for this intent, so a UI honouring it would ask the
    // user to approve something they cannot see.
    await expect(ctx.userQuestions.ask({
      questions: [{
        id: 'plan-review', question: 'Approve?',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'BAD_INTENT' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('passes an intent through once its approve label names an offered option', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider('Approve')
    ctx.userQuestions.registerProvider(p)
    const intent = { kind: 'plan-review', approve: 'Approve' } as const

    const result = await ctx.userQuestions.ask({
      questions: [
        { id: 'plain', question: 'Proceed?' },
        {
          id: 'plan-review', question: 'Approve?', detail: '# Plan',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent,
        },
      ],
    })

    expect(result.answers).toEqual([{ id: 'plain', selected: ['Approve'] }])
    expect(p.seen[0]?.questions[1]?.intent).toEqual(intent)
  })
})

describe('user-questions/provider-dispatch', () => {
  it('emits nothing for every pre-dispatch rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const dispatched = vi.fn()
    ctx.on('user-questions/provider-dispatch', dispatched)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    })).rejects.toMatchObject({ code: 'NO_PROVIDER' })

    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    ctx.userQuestions.registerProvider(p)
    const aborted = new AbortController()
    aborted.abort()
    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      signal: aborted.signal,
    })).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await expect(ctx.userQuestions.ask({ questions: [] }))
      .rejects.toMatchObject({ code: 'EMPTY_QUESTIONS' })
    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('not-live'),
    })).rejects.toMatchObject({ code: 'CALLER_NOT_LIVE' })

    const root = stubAgent('dispatch-root')
    const child = stubAgent('dispatch-child')
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)
    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: child,
    })).rejects.toMatchObject({ code: 'DELEGATED_CALLER' })
    await expect(ctx.userQuestions.ask({
      questions: [{
        id: 'plan',
        question: 'Approve?',
        detail: '# Plan',
        options: [{ label: 'Approve' }],
        intent: { kind: 'plan-review', approve: 'Missing' },
      }],
    })).rejects.toMatchObject({ code: 'BAD_INTENT' })

    expect(dispatched).not.toHaveBeenCalled()
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('brackets an asynchronous provider call and emits for an agentless request', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const pending = Promise.withResolvers<{ answers: { id: string; selected: string[] }[] }>()
    const order: string[] = []
    ctx.on('user-questions/provider-dispatch', (lifecycle) => {
      order.push(`dispatch:${lifecycle.request.questions[0]?.id}`)
      lifecycle.defer(() => { order.push('cleanup') })
    })
    ctx.userQuestions.registerProvider({
      ask: () => {
        order.push('provider')
        return pending.promise
      },
    })

    const asked = ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] })
    expect(order).toEqual(['dispatch:confirm', 'provider'])
    pending.resolve({ answers: [{ id: 'confirm', selected: ['yes'] }] })

    await expect(asked).resolves.toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
    expect(order).toEqual(['dispatch:confirm', 'provider', 'cleanup'])
  })

  it('contains listener and cleanup failures without replacing provider rejection', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const later: string[] = []
    ctx.on('user-questions/provider-dispatch', () => { throw new Error('listener threw') })
    ctx.on('user-questions/provider-dispatch', () => Promise.reject(new Error('listener rejected')) as never)
    ctx.on('user-questions/provider-dispatch', (lifecycle) => {
      lifecycle.defer(() => { throw new Error('cleanup threw') })
      lifecycle.defer(() => { later.push('cleanup') })
      later.push('listener')
    })
    ctx.userQuestions.registerProvider({ ask: async () => { throw new Error('provider rejected') } })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    })).rejects.toThrow('provider rejected')
    await Promise.resolve()

    expect(later).toEqual(['listener', 'cleanup'])
    expect(warned.mock.calls.map(([message]) => String(message))).toEqual(expect.arrayContaining([
      expect.stringContaining('listener threw'),
      expect.stringContaining('listener rejected'),
      expect.stringContaining('cleanup threw'),
    ]))
  })
})
