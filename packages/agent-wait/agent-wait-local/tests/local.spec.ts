import { describe, expect, it, vi } from 'vitest'
import { Context, symbols, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { AgentWaitEpoch, type AgentWaitCursor, type AgentWaitLease } from '@deepseek-ai/dsh-agent-wait'
import LocalAgentWaitRegistry from '@deepseek-ai/dsh-agent-wait-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

function stubAgent(rawId: string): Agent {
  const id = SessionId(rawId)
  return { id, session: Session.create(id) } as unknown as Agent
}

async function provider(retainedTransitionLimit = 8): Promise<{
  ctx: Context
  fiber: Fiber
  registry: LocalAgentWaitRegistry
}> {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalAgentWaitRegistry, { retainedTransitionLimit })
  await fiber
  const traced = ctx.agentWaits as LocalAgentWaitRegistry & {
    [symbols.original]?: LocalAgentWaitRegistry
  }
  return { ctx, fiber, registry: traced[symbols.original] ?? traced }
}

describe('LocalAgentWaitRegistry', () => {
  it('publishes one ended transition for repeated release calls', async () => {
    const { registry } = await provider()
    const before = registry.snapshot().cursor
    const lease = registry.acquire({
      lifetime: { kind: 'agent', agent: stubAgent('release') },
      reason: 'interaction',
    })

    lease.release()
    lease.release()

    expect(registry.snapshot().leases).toEqual([])
    const read = registry.changes(before)
    expect(read.kind).toBe('changes')
    if (read.kind !== 'changes') return
    expect(read.transitions.map(transition => transition.kind === 'ended'
      ? `${transition.kind}:${transition.termination}`
      : transition.kind)).toEqual(['acquired', 'ended:released'])
  })

  it('releases exact-agent leases when the registered agent is disposed', async () => {
    const { ctx, registry } = await provider()
    await ctx.plugin(AgentRegistry)
    const agent = stubAgent('disposed-agent')
    const disposeAgent = ctx.agents.register(agent)
    const before = registry.snapshot().cursor
    registry.acquire({ lifetime: { kind: 'agent', agent }, reason: 'interaction' })

    disposeAgent()

    expect(registry.snapshot().leases).toEqual([])
    const read = registry.changes(before)
    expect(read.kind === 'changes' ? read.transitions.at(-1) : undefined).toMatchObject({
      kind: 'ended',
      termination: 'released',
    })
  })

  it('expires bounded observations with observation-timeout', async () => {
    vi.useFakeTimers()
    try {
      const { registry } = await provider()
      const before = registry.snapshot().cursor
      const lease = registry.acquire({
        lifetime: { kind: 'observation', sessionId: SessionId('observed'), timeoutMs: 25 },
        reason: 'peer',
      })

      await vi.advanceTimersByTimeAsync(25)
      lease.release()

      expect(registry.snapshot().leases).toEqual([])
      const read = registry.changes(before)
      expect(read.kind === 'changes' ? read.transitions.at(-1) : undefined).toMatchObject({
        kind: 'ended',
        termination: 'observation-timeout',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('bridges retained cursors and refreshes epoch changes and retention gaps', async () => {
    const { registry } = await provider(2)
    const initial = registry.snapshot().cursor
    const first = registry.acquire({
      lifetime: { kind: 'agent', agent: stubAgent('first') },
      reason: 'interaction',
    })
    const afterAcquire = registry.snapshot().cursor
    first.release()

    const bridged = registry.changes(afterAcquire)
    expect(bridged.kind).toBe('changes')
    expect(bridged.kind === 'changes' ? bridged.transitions : []).toHaveLength(1)

    registry.acquire({
      lifetime: { kind: 'agent', agent: stubAgent('second') },
      reason: 'peer',
    })

    expect(registry.changes(initial)).toMatchObject({ kind: 'refresh', reason: 'revision-gap' })
    expect(registry.changes({ ...initial, epoch: AgentWaitEpoch('another-process') }))
      .toMatchObject({ kind: 'refresh', reason: 'epoch-changed' })
  })

  it('retries a snapshot when a transition commits between its cursor reads', async () => {
    const { registry } = await provider()
    const first = registry.acquire({
      lifetime: { kind: 'agent', agent: stubAgent('snapshot-first') },
      reason: 'interaction',
    })
    const original = Reflect.get(registry, 'cursor') as () => AgentWaitCursor
    let reads = 0
    let injected: AgentWaitLease | undefined
    Reflect.set(registry, 'cursor', () => {
      reads += 1
      if (reads === 2) {
        injected = registry.acquire({
          lifetime: { kind: 'agent', agent: stubAgent('snapshot-second') },
          reason: 'peer',
        })
      }
      return Reflect.apply(original, registry, [])
    })

    let snapshot: ReturnType<LocalAgentWaitRegistry['snapshot']>
    try {
      snapshot = registry.snapshot()
    } finally {
      Reflect.set(registry, 'cursor', original)
    }

    expect(snapshot.leases.map(lease => lease.sessionId)).toEqual([
      SessionId('snapshot-first'),
      SessionId('snapshot-second'),
    ])
    expect(snapshot.cursor).toEqual(registry.snapshot().cursor)
    first.release()
    injected?.release()
  })

  it('contains observer failures and still notifies later observers', async () => {
    const { ctx, registry } = await provider()
    const warned = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const heard: AgentWaitCursor[] = []
    registry.onChanged(() => { throw new Error('sync observer') })
    registry.onChanged(() => Promise.reject(new Error('async observer')))
    registry.onChanged(cursor => void heard.push(cursor))

    registry.acquire({
      lifetime: { kind: 'agent', agent: stubAgent('observer') },
      reason: 'interaction',
    })
    await Promise.resolve()

    expect(heard).toHaveLength(1)
    expect(warned.mock.calls.map(([message]) => String(message))).toEqual(expect.arrayContaining([
      expect.stringContaining('listener threw'),
      expect.stringContaining('listener rejected'),
    ]))
  })

  it('unregisters on fiber disposal and makes replacement a revision gap in the same epoch', async () => {
    const first = await provider()
    const cursor = first.registry.snapshot().cursor
    const lease = first.registry.acquire({
      lifetime: { kind: 'agent', agent: stubAgent('hmr') },
      reason: 'interaction',
    })

    await first.fiber.dispose()

    expect(first.ctx.get('agentWaits')).toBeUndefined()
    expect(() => { lease.release() }).not.toThrow()
    const replacementFiber = first.ctx.plugin(LocalAgentWaitRegistry, { retainedTransitionLimit: 8 })
    await replacementFiber
    expect(first.ctx.agentWaits.snapshot().cursor.epoch).toBe(cursor.epoch)
    expect(first.ctx.agentWaits.changes(cursor)).toMatchObject({
      kind: 'refresh',
      reason: 'revision-gap',
    })
    await replacementFiber.dispose()
  })
})
