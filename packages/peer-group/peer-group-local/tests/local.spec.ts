import { describe, expect, it, vi } from 'vitest'
import { Context, symbols, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import LocalAgentWaitRegistry from '@deepseek-ai/dsh-agent-wait-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { PeerGroupId, type PeerGroupError, type PeerWaitSpec } from '@deepseek-ai/dsh-peer-group'
import LocalPeerGroupRegistry from '@deepseek-ai/dsh-peer-group-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

interface TestAgent {
  readonly agent: Agent
  readonly received: UserMessage[]
  readonly detach: () => void
  setStatus(status: AgentStatus): void
}

interface Harness {
  readonly ctx: Context
  readonly fiber: Fiber
  readonly agentWaitRegistry: LocalAgentWaitRegistry
  readonly registry: LocalPeerGroupRegistry
  root(id: string, cwd?: string): TestAgent
  child(id: string, owner: Agent, cwd?: string): TestAgent
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SandboxPolicyService, { workspaceRoot: '/tmp' })
  const agentWaitFiber = ctx.plugin(LocalAgentWaitRegistry, { retainedTransitionLimit: 64 })
  await agentWaitFiber
  const tracedAgentWaits = ctx.agentWaits as LocalAgentWaitRegistry & {
    [symbols.original]?: LocalAgentWaitRegistry
  }
  const agentWaitRegistry = tracedAgentWaits[symbols.original] ?? tracedAgentWaits
  const fiber = ctx.plugin(LocalPeerGroupRegistry, {
    defaultWaitTimeoutMs: 1_000,
    maxWaitTimeoutMs: 10_000,
  })
  await fiber
  const traced = ctx.peerGroups as LocalPeerGroupRegistry & {
    [symbols.original]?: LocalPeerGroupRegistry
  }
  const registry = traced[symbols.original] ?? traced

  const defaultWorkspaces = ['/tmp', '/', '/home/river/PythonProject/deepseek-harness']
  let nextWorkspace = 0
  const createAgent = (id: string, owner: Agent | undefined, cwd?: string): TestAgent => {
    const sessionId = SessionId(id)
    const workspace = cwd ?? defaultWorkspaces[nextWorkspace++ % defaultWorkspaces.length] ?? '/tmp'
    const session = ctx.sessions.create(sessionId, { meta: { cwd: workspace } })
    const received: UserMessage[] = []
    let status: AgentStatus = 'idle'
    const agent = {
      id: sessionId,
      options: {},
      session,
      inbox: {},
      ctx,
      get status() { return status },
      cancel() {},
      whenIdle: () => Promise.resolve(),
      runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
      send(message: UserMessage) { received.push(message) },
      followup(message: UserMessage) { received.push(message) },
      steer(message: UserMessage) { received.push(message) },
      inject(message: UserMessage) { received.push(message) },
    } as unknown as Agent
    const detach = ctx.agents.enter(agent, owner)
    return {
      agent,
      received,
      detach,
      setStatus(next) {
        status = next
        ctx.emit('agent/status', { agent, status: next })
      },
    }
  }

  return {
    ctx,
    fiber,
    agentWaitRegistry,
    registry,
    root: (id, cwd) => createAgent(id, undefined, cwd),
    child: (id, owner, cwd) => createAgent(id, owner, cwd),
  }
}

function spec(until: PeerWaitSpec['until'], timeoutMs = 1_000): PeerWaitSpec {
  return { until, timeoutMs }
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error: unknown) {
    return (error as PeerGroupError).code
  }
}

function appendPolicy(session: Session, mode: 'read-only' | 'workspace-write', approval: 'ask' | 'never'): void {
  session.append('sandbox/mode', { mode })
  session.append('approval/policy', { policy: approval })
}

function internalSize(registry: LocalPeerGroupRegistry, field: 'edges' | 'waits'): number {
  return (Reflect.get(registry, field) as Map<unknown, unknown>).size
}

describe('LocalPeerGroupRegistry membership', () => {
  it('admits exact roots and loudly refuses a delegated Agent', async () => {
    const test = await harness()
    const root = test.root('root')
    const child = test.child('child', root.agent)

    await expect(test.registry.create(root.agent, 'roots')).resolves.toMatchObject({ id: 'roots' })
    await expect(test.registry.add(root.agent, PeerGroupId('roots'), child.agent.id))
      .rejects.toMatchObject({ code: 'MEMBER_NOT_ROOT' })
    await expect(test.registry.create(child.agent, 'children'))
      .rejects.toMatchObject({ code: 'CALLER_NOT_ROOT' })
  })

  it('validates exact group names without folding or normalization', async () => {
    const test = await harness()
    const root = test.root('root')

    for (const name of ['', 'Upper', 'two words', '-start', 'a'.repeat(33)]) {
      await expect(test.registry.create(root.agent, name)).rejects.toMatchObject({ code: 'BAD_GROUP_NAME' })
    }
    await expect(test.registry.create(root.agent, 'exact_name-1')).resolves.toMatchObject({
      id: 'exact_name-1',
      name: 'exact_name-1',
    })
  })

  it('mints a fresh incarnation when a removed session is admitted again', async () => {
    const test = await harness()
    const first = test.root('first')
    const second = test.root('second')
    const group = await test.registry.create(first.agent, 'team')
    const admitted = await test.registry.add(first.agent, group.id, second.agent.id)

    await test.registry.remove(first.agent, group.id, second.agent.id)
    const replacement = await test.registry.add(first.agent, group.id, second.agent.id)

    expect(replacement.incarnation).not.toBe(admitted.incarnation)
  })

  it('enforces one writer per canonical workspace while allowing other workspaces', async () => {
    const test = await harness()
    const writer = test.root('writer', '/tmp')
    const sameWriter = test.root('same-writer', '/tmp')
    const sameReader = test.root('same-reader', '/tmp')
    const elsewhere = test.root('elsewhere', '/')
    appendPolicy(sameReader.agent.session, 'read-only', 'never')
    const group = await test.registry.create(writer.agent, 'guard')

    await expect(test.registry.add(writer.agent, group.id, sameWriter.agent.id))
      .rejects.toMatchObject({ code: 'SECOND_WRITER' })
    await expect(test.registry.add(writer.agent, group.id, sameReader.agent.id))
      .resolves.toMatchObject({ writeAccess: 'read-only' })
    await expect(test.registry.add(writer.agent, group.id, elsewhere.agent.id))
      .resolves.toMatchObject({ writeAccess: 'write-capable' })
  })

  it('honors a later policy change, removes the violating member, and logs the removal', async () => {
    const test = await harness()
    const writer = test.root('writer', '/tmp')
    const approvalReader = test.root('approval-reader', '/tmp')
    const sandboxReader = test.root('sandbox-reader', '/tmp')
    appendPolicy(approvalReader.agent.session, 'read-only', 'never')
    appendPolicy(sandboxReader.agent.session, 'read-only', 'never')
    const group = await test.registry.create(writer.agent, 'policy')
    const approvalMembership = await test.registry.add(writer.agent, group.id, approvalReader.agent.id)
    const sandboxMembership = await test.registry.add(writer.agent, group.id, sandboxReader.agent.id)

    approvalReader.agent.session.append('approval/policy', { policy: 'ask' })
    sandboxReader.agent.session.append('sandbox/mode', { mode: 'workspace-write' })
    await Promise.resolve()

    expect(test.registry.list(writer.agent, group.id)[0]?.members).toHaveLength(1)
    expect(approvalReader.agent.session.events.at(-1)).toMatchObject({
      type: 'peer-group/membership-removed',
      data: { groupId: group.id, incarnation: approvalMembership.incarnation, reason: 'second-writer' },
    })
    expect(sandboxReader.agent.session.events.at(-1)).toMatchObject({
      type: 'peer-group/membership-removed',
      data: { groupId: group.id, incarnation: sandboxMembership.incarnation, reason: 'second-writer' },
    })
  })

  it('requires bounded timeout configuration and resolves the default wait predicate', async () => {
    const test = await harness()

    expect(test.registry.resolveWait()).toEqual({ until: ['idle', 'blocked'], timeoutMs: 1_000 })
    expect(() => test.registry.resolveWait({ timeoutMs: 10_001 })).toThrow(expect.objectContaining({
      code: 'WAIT_TIMEOUT',
    }))
  })
})

describe('LocalPeerGroupRegistry delivery and waits', () => {
  it('refuses interaction-blocked delivery, allows peer-only delivery, and gives interaction precedence', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const target = test.root('target')
    const group = await test.registry.create(sender.agent, 'delivery')
    await test.registry.add(sender.agent, group.id, target.agent.id)
    const peerLease = test.ctx.agentWaits.acquire({ lifetime: { kind: 'agent', agent: target.agent }, reason: 'peer' })

    await expect(test.registry.send({ caller: sender.agent, peer: { group: group.id, session: target.agent.id }, message: 'peer-only' }))
      .resolves.toMatchObject({ delivery: { peer: { sessionId: target.agent.id } } })
    expect(target.received.at(-1)?.source).toMatchObject({ kind: 'peer', groupId: group.id })

    const interaction = test.ctx.agentWaits.acquire({ lifetime: { kind: 'agent', agent: target.agent }, reason: 'interaction' })
    expect(test.registry.list(sender.agent, group.id)[0]?.members[1]?.execution)
      .toEqual({ state: 'blocked', reason: 'interaction' })
    await expect(test.registry.send({ caller: sender.agent, peer: { group: group.id, session: target.agent.id }, message: 'blocked' }))
      .rejects.toMatchObject({ code: 'PEER_BLOCKED_INTERACTION' })
    interaction.release()
    peerLease.release()
  })

  it('reports a detached member inactive and fails delivery and waits with PEER_UNAVAILABLE', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const target = test.root('target')
    const group = await test.registry.create(sender.agent, 'inactive')
    await test.registry.add(sender.agent, group.id, target.agent.id)
    target.detach()

    expect(test.registry.list(sender.agent, group.id)[0]?.members[1]).toMatchObject({
      sessionId: target.agent.id,
      availability: 'inactive',
    })
    await expect(test.registry.send({
      caller: sender.agent,
      peer: { group: group.id, session: target.agent.id },
      message: 'hello',
    })).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' })
    await expect(test.registry.wait({
      caller: sender.agent,
      peer: { group: group.id, session: target.agent.id },
      wait: spec(['idle']),
    })).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' })
    expect(internalSize(test.registry, 'edges')).toBe(0)
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('settles a delivery wait only from its own claimed turn', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const target = test.root('target')
    const group = await test.registry.create(sender.agent, 'turns')
    await test.registry.add(sender.agent, group.id, target.agent.id)
    const sent = test.registry.send({
      caller: sender.agent,
      peer: { group: group.id, session: target.agent.id },
      message: 'owned',
      wait: spec(['idle']),
    })
    const delivered = target.received[0]
    expect(delivered).toBeDefined()

    const unrelated = createUserMessage({ content: [{ type: 'text', text: 'other' }], source: { kind: 'user' } })
    target.setStatus('running')
    test.ctx.emit('agent/inbox/claimed', { agent: target.agent, message: unrelated, turn: 0 })
    target.agent.session.append('turn/start', { turn: 0 })
    target.agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    target.setStatus('idle')
    let settled = false
    void sent.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    target.setStatus('running')
    test.ctx.emit('agent/inbox/claimed', { agent: target.agent, message: delivered as UserMessage, turn: 1 })
    target.agent.session.append('turn/start', { turn: 1 })
    target.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    target.setStatus('idle')

    await expect(sent).resolves.toMatchObject({ settled: { turn: 1, execution: { state: 'idle' } } })
  })

  it('matches a standalone wait against the initial snapshot', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    const group = await test.registry.create(waiter.agent, 'snapshot')
    await test.registry.add(waiter.agent, group.id, target.agent.id)

    await expect(test.registry.wait({
      caller: waiter.agent,
      peer: { group: group.id, session: target.agent.id },
      wait: test.registry.resolveWait(),
    })).resolves.toMatchObject({ execution: { state: 'idle' } })
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
    expect(internalSize(test.registry, 'edges')).toBe(0)
  })

  it('distinguishes a stalled delivery effect from the shorter user timeout', async () => {
    vi.useFakeTimers()
    try {
      const test = await harness()
      const sender = test.root('sender')
      const target = test.root('target')
      const group = await test.registry.create(sender.agent, 'effects')
      await test.registry.add(sender.agent, group.id, target.agent.id)

      const stalled = test.registry.send({
        caller: sender.agent,
        peer: { group: group.id, session: target.agent.id },
        message: 'stalled',
        wait: spec(['idle'], 6_000),
      })
      const stalledCode = errorCode(stalled)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await stalledCode).toBe('PROMPT_STALLED')

      const timedOut = test.registry.send({
        caller: sender.agent,
        peer: { group: group.id, session: target.agent.id },
        message: 'timeout',
        wait: spec(['idle'], 4_000),
      })
      const timeoutCode = errorCode(timedOut)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(await timeoutCode).toBe('WAIT_TIMEOUT')
      expect(internalSize(test.registry, 'edges')).toBe(0)
      expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects cycles and releases the installed edge and lease after abort', async () => {
    const test = await harness()
    const first = test.root('first')
    const second = test.root('second')
    const group = await test.registry.create(first.agent, 'cycles')
    await test.registry.add(first.agent, group.id, second.agent.id)
    const controller = new AbortController()
    const firstWait = test.registry.wait({
      caller: first.agent,
      peer: { group: group.id, session: second.agent.id },
      wait: spec(['working']),
      signal: controller.signal,
    })

    await expect(test.registry.wait({
      caller: second.agent,
      peer: { group: group.id, session: first.agent.id },
      wait: spec(['working']),
    })).rejects.toMatchObject({ code: 'WAIT_CYCLE' })
    controller.abort()
    await expect(firstWait).rejects.toMatchObject({ code: 'WAIT_ABORTED' })
    expect(internalSize(test.registry, 'edges')).toBe(0)
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('ends a pinned wait when membership is replaced and cleans graph state', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    const group = await test.registry.create(waiter.agent, 'replacement')
    await test.registry.add(waiter.agent, group.id, target.agent.id)
    const waiting = test.registry.wait({
      caller: waiter.agent,
      peer: { group: group.id, session: target.agent.id },
      wait: spec(['working']),
    })

    await test.registry.remove(waiter.agent, group.id, target.agent.id)
    await test.registry.add(waiter.agent, group.id, target.agent.id)

    await expect(waiting).rejects.toMatchObject({ code: 'MEMBERSHIP_REPLACED' })
    expect(internalSize(test.registry, 'edges')).toBe(0)
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('ends target disposal as PEER_UNAVAILABLE and group dissolution distinctly', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    const group = await test.registry.create(waiter.agent, 'endings')
    await test.registry.add(waiter.agent, group.id, target.agent.id)
    const unavailable = test.registry.wait({
      caller: waiter.agent,
      peer: { group: group.id, session: target.agent.id },
      wait: spec(['working']),
    })
    test.ctx.emit('agent/disposed', { agent: target.agent })
    await expect(unavailable).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' })

    const dissolved = test.registry.wait({
      caller: waiter.agent,
      peer: { group: group.id, session: target.agent.id },
      wait: spec(['working']),
    })
    await test.registry.dissolve(waiter.agent, group.id)
    await expect(dissolved).rejects.toMatchObject({ code: 'GROUP_DISSOLVED' })
    expect(internalSize(test.registry, 'edges')).toBe(0)
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('ends waiter disposal as WAIT_ABORTED and releases its graph state', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    const group = await test.registry.create(waiter.agent, 'waiter-disposal')
    await test.registry.add(waiter.agent, group.id, target.agent.id)
    const waiting = test.registry.wait({
      caller: waiter.agent,
      peer: { group: group.id, session: target.agent.id },
      wait: spec(['working']),
    })

    test.ctx.emit('agent/disposed', { agent: waiter.agent })

    await expect(waiting).rejects.toMatchObject({ code: 'WAIT_ABORTED' })
    expect(internalSize(test.registry, 'edges')).toBe(0)
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('ends active waits and removes graph state when wait observation fails', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    const group = await test.registry.create(waiter.agent, 'subscription')
    await test.registry.add(waiter.agent, group.id, target.agent.id)
    const waiting = test.registry.wait({
      caller: waiter.agent,
      peer: { group: group.id, session: target.agent.id },
      wait: spec(['working']),
    })

    Reflect.set(test.agentWaitRegistry, 'changes', () => { throw new Error('observation failed') })
    Reflect.apply(Reflect.get(test.registry, 'drainWaitChanges') as () => void, test.registry, [])

    await expect(waiting).rejects.toMatchObject({ code: 'SUBSCRIPTION_FAILED' })
    expect(internalSize(test.registry, 'edges')).toBe(0)
  })

  it('rejects pending waits and removes the service on provider-fiber disposal', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    const group = await test.registry.create(waiter.agent, 'hmr')
    await test.registry.add(waiter.agent, group.id, target.agent.id)
    const waiting = test.registry.wait({
      caller: waiter.agent,
      peer: { group: group.id, session: target.agent.id },
      wait: spec(['working']),
    })

    await test.fiber.dispose()

    await expect(waiting).rejects.toMatchObject({ code: 'PROVIDER_DISPOSED' })
    expect(test.ctx.get('peerGroups')).toBeUndefined()
    expect(internalSize(test.registry, 'edges')).toBe(0)
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
  })
})
