import { describe, expect, it, vi } from 'vitest'
import { Context, symbols, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import LocalAgentWaitRegistry from '@deepseek-ai/dsh-agent-wait-local'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { PeerError, PeerWaitSpec } from '@deepseek-ai/dsh-peer'
import LocalPeerRegistry from '@deepseek-ai/dsh-peer-local'
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
  readonly registry: LocalPeerRegistry
  root(id: string, cwd?: string, preset?: string): TestAgent
  child(id: string, owner: Agent, cwd?: string): TestAgent
  archive(sessionId: SessionId): void
}

async function harness(withCommands = false, dispatchableCommands?: string[]): Promise<Harness> {
  const ctx = new Context()
  const archivedSessionIds: SessionId[] = []
  // Only the archive set is consulted, so the registry stands in as the
  // optional service the Web bundle composes and the shared base does not.
  ctx.provide('workspaceRegistry', { get archivedSessionIds() { return archivedSessionIds } })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  if (withCommands) await ctx.plugin(CommandRuntime)
  await ctx.plugin(SandboxPolicyService, { workspaceRoot: '/tmp' })
  const agentWaitFiber = ctx.plugin(LocalAgentWaitRegistry, { retainedTransitionLimit: 64 })
  await agentWaitFiber
  const tracedAgentWaits = ctx.agentWaits as LocalAgentWaitRegistry & {
    [symbols.original]?: LocalAgentWaitRegistry
  }
  const agentWaitRegistry = tracedAgentWaits[symbols.original] ?? tracedAgentWaits
  const fiber = ctx.plugin(LocalPeerRegistry, {
    defaultWaitTimeoutMs: 1_000,
    maxWaitTimeoutMs: 10_000,
    ...dispatchableCommands === undefined ? {} : { dispatchableCommands },
  })
  await fiber
  const traced = ctx.peers as LocalPeerRegistry & { [symbols.original]?: LocalPeerRegistry }
  const registry = traced[symbols.original] ?? traced

  const defaultWorkspaces = ['/tmp', '/', '/home/river/PythonProject/deepseek-harness']
  let nextWorkspace = 0
  const createAgent = (id: string, owner: Agent | undefined, cwd?: string, preset?: string): TestAgent => {
    const sessionId = SessionId(id)
    const workspace = cwd ?? defaultWorkspaces[nextWorkspace++ % defaultWorkspaces.length] ?? '/tmp'
    const session = ctx.sessions.create(sessionId, {
      meta: { cwd: workspace, ...preset === undefined ? {} : { agentPreset: preset } },
    })
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
    root: (id, cwd, preset) => createAgent(id, undefined, cwd, preset),
    child: (id, owner, cwd) => createAgent(id, owner, cwd),
    archive: (sessionId) => { archivedSessionIds.push(sessionId) },
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
    return (error as PeerError).code
  }
}

function appendPolicy(session: Session, mode: 'read-only' | 'workspace-write', approval: 'ask' | 'never'): void {
  session.append('sandbox/mode', { mode })
  session.append('approval/policy', { policy: approval })
}

function rename(session: Session, title: string, kind: 'user' | 'fallback' = 'user'): void {
  session.append('session/title', {
    title,
    messageSeqs: [],
    source: { kind },
  })
}

function internalSize(registry: LocalPeerRegistry, field: 'edges' | 'waits'): number {
  return (Reflect.get(registry, field) as Map<unknown, unknown>).size
}

function callPrivate(registry: LocalPeerRegistry, name: string, args: readonly unknown[] = []): unknown {
  const method = Reflect.get(registry, name) as (...values: unknown[]) => unknown
  return Reflect.apply(method, registry, args)
}

describe('LocalPeerRegistry discovery and authority', () => {
  it('lists every other active root with title provenance and excludes delegated Agents', async () => {
    const test = await harness()
    const caller = test.root('caller')
    const userNamed = test.root('user-named')
    const automatic = test.root('automatic')
    test.child('child', caller.agent)
    rename(userNamed.agent.session, 'reviewer')
    rename(automatic.agent.session, 'generated summary', 'fallback')

    expect(test.registry.list(caller.agent)).toEqual([
      expect.objectContaining({ sessionId: userNamed.agent.id, title: 'reviewer', titleSource: 'user' }),
      expect.objectContaining({ sessionId: automatic.agent.id, title: 'generated summary', titleSource: 'automatic' }),
    ])
  })

  it('projects selected preset labels and an absent title', async () => {
    const test = await harness()
    const caller = test.root('caller')
    const preset = test.root('preset-root', '/', 'reviewer')

    expect(test.registry.list(caller.agent)).toContainEqual(expect.objectContaining({
      sessionId: preset.agent.id,
      workspace: '/',
      preset: 'reviewer',
    }))
    expect(test.registry.list(caller.agent)[0]).not.toHaveProperty('title')
  })

  it('revalidates the exact caller as a live root for list, send, and wait', async () => {
    const test = await harness()
    const root = test.root('root')
    const target = test.root('target')
    const child = test.child('child', root.agent)

    expect(() => test.registry.list(child.agent)).toThrow(expect.objectContaining({ code: 'CALLER_NOT_ROOT' }))
    await expect(test.registry.send({ caller: child.agent, peer: target.agent.id, message: 'no' }))
      .rejects.toMatchObject({ code: 'CALLER_NOT_ROOT' })
    await expect(test.registry.wait({ caller: child.agent, peer: target.agent.id, wait: spec(['idle']) }))
      .rejects.toMatchObject({ code: 'CALLER_NOT_ROOT' })

    root.detach()
    expect(() => test.registry.list(root.agent)).toThrow(expect.objectContaining({ code: 'CALLER_NOT_LIVE' }))
  })

  it('resolves id before a unique user title and rejects ambiguity, automatic titles, and self-addressing', async () => {
    const test = await harness()
    const caller = test.root('caller')
    const first = test.root('first')
    const second = test.root('second')
    const automatic = test.root('automatic')
    rename(first.agent.session, 'reviewer')
    rename(second.agent.session, 'reviewer')
    rename(automatic.agent.session, 'generated', 'fallback')
    rename(caller.agent.session, 'myself')

    await expect(test.registry.send({ caller: caller.agent, peer: first.agent.id, message: 'id wins' }))
      .resolves.toMatchObject({ delivery: { peerSessionId: first.agent.id } })
    await expect(test.registry.send({ caller: caller.agent, peer: 'reviewer', message: 'ambiguous' }))
      .rejects.toMatchObject({ code: 'AMBIGUOUS_PEER' })
    await expect(test.registry.send({ caller: caller.agent, peer: 'generated', message: 'automatic' }))
      .rejects.toMatchObject({ code: 'PEER_NOT_FOUND' })
    await expect(test.registry.send({ caller: caller.agent, peer: caller.agent.id, message: 'self' }))
      .rejects.toMatchObject({ code: 'SELF_PEER' })
    await expect(test.registry.send({ caller: caller.agent, peer: 'myself', message: 'self' }))
      .rejects.toMatchObject({ code: 'SELF_PEER' })
  })

  it('requires bounded timeout configuration and resolves the default wait predicate', async () => {
    const test = await harness()

    expect(test.registry.resolveWait()).toEqual({ until: ['idle', 'blocked'], timeoutMs: 1_000 })
    expect(() => test.registry.resolveWait({ timeoutMs: 10_001 })).toThrow(expect.objectContaining({
      code: 'WAIT_TIMEOUT',
    }))
    expect(() => test.registry.resolveWait({ until: [] })).toThrow(expect.objectContaining({ code: 'WAIT_TIMEOUT' }))
    expect(() => test.registry.resolveWait({ timeoutMs: 0 })).toThrow(expect.objectContaining({ code: 'WAIT_TIMEOUT' }))
    expect(test.registry.resolveWait({ until: ['idle', 'idle'], timeoutMs: 2_000 }))
      .toEqual({ until: ['idle'], timeoutMs: 2_000 })
  })

  it('rejects inverted deployment timeout bounds', () => {
    const ctx = new Context()
    expect(() => new LocalPeerRegistry(ctx, {
      defaultWaitTimeoutMs: 2,
      maxWaitTimeoutMs: 1,
    })).toThrow('defaultWaitTimeoutMs must not exceed maxWaitTimeoutMs')
  })
})

describe('LocalPeerRegistry delivery and waits', () => {
  it('honors already-aborted delivery and wait requests before side effects', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const target = test.root('target')
    const controller = new AbortController()
    controller.abort()

    await expect(test.registry.send({
      caller: sender.agent, peer: target.agent.id, message: 'aborted', signal: controller.signal,
    })).rejects.toMatchObject({ code: 'WAIT_ABORTED' })
    await expect(test.registry.wait({
      caller: sender.agent, peer: target.agent.id, wait: spec(['idle']), signal: controller.signal,
    })).rejects.toMatchObject({ code: 'WAIT_ABORTED' })
    expect(target.received).toEqual([])
  })

  it('reports a shared writable workspace without refusing delivery', async () => {
    const test = await harness()
    const sender = test.root('sender', '/tmp')
    const target = test.root('target', '/tmp')

    const [listed] = test.registry.list(sender.agent)
    expect(listed).toMatchObject({ sessionId: target.agent.id, sharesWritableWorkspace: true })
    await expect(test.registry.send({ caller: sender.agent, peer: target.agent.id, message: 'collides' }))
      .resolves.toMatchObject({ delivery: { peerSessionId: target.agent.id, sharesWritableWorkspace: true } })
    expect(target.received).toHaveLength(1)

    appendPolicy(target.agent.session, 'read-only', 'never')
    expect(test.registry.list(sender.agent)[0]).not.toHaveProperty('sharesWritableWorkspace')
    const safe = await test.registry.send({ caller: sender.agent, peer: target.agent.id, message: 'safe' })
    expect(safe.kind).toBe('message')
    if (safe.kind !== 'message') throw new Error('expected a delivered message')
    expect(safe.delivery).not.toHaveProperty('sharesWritableWorkspace')

    const reader = test.root('reader', '/tmp')
    appendPolicy(reader.agent.session, 'read-only', 'never')
    expect(test.registry.list(reader.agent).find(peer => peer.sessionId === sender.agent.id))
      .not.toHaveProperty('sharesWritableWorkspace')
  })

  it('runs a recognized slash line in the peer command plane instead of delivering it', async () => {
    const test = await harness(true)
    const sender = test.root('sender')
    const target = test.root('target')
    const runs: string[] = []
    test.ctx.commands.register({
      name: 'compact',
      description: 'test command',
      handler: (invocation) => {
        runs.push(invocation.rawInput)
        return { kind: 'success', text: 'compacted' }
      },
    })
    const ran = await test.registry.send({ caller: sender.agent, peer: target.agent.id, message: '/compact now' })
    expect(ran).toMatchObject({
      kind: 'command',
      command: { peerSessionId: target.agent.id, name: 'compact' },
    })
    expect(runs).toEqual([' now'])
    expect(target.received).toEqual([])
    expect(target.agent.session.events.some(event => event.type === 'command/run'
      && (event.data as { source: { kind: string } }).source.kind === 'peer')).toBe(true)

    const waited = await test.registry.send({
      caller: sender.agent,
      peer: target.agent.id,
      message: '/compact again',
      wait: spec(['idle']),
    })
    expect(waited).toMatchObject({
      kind: 'command',
      command: { name: 'compact' },
      settled: { execution: { state: 'idle' } },
    })
    expect(target.received).toEqual([])

    const unknown = await test.registry.send({ caller: sender.agent, peer: target.agent.id, message: '/nope' })
    expect(unknown.kind).toBe('message')
    const ordinary = await test.registry.send({ caller: sender.agent, peer: target.agent.id, message: 'hello' })
    expect(ordinary.kind).toBe('message')
    expect(target.received).toHaveLength(2)
  })

  it('delivers a recognized slash line as text when the peer command allowlist excludes it', async () => {
    const test = await harness(true, [])
    const sender = test.root('sender')
    const target = test.root('target')
    const handler = vi.fn(() => ({ kind: 'success' as const }))
    test.ctx.commands.register({ name: 'compact', description: 'test command', handler })

    const delivered = await test.registry.send({
      caller: sender.agent,
      peer: target.agent.id,
      message: '/compact',
    })

    expect(delivered.kind).toBe('message')
    expect(handler).not.toHaveBeenCalled()
    expect(target.received).toHaveLength(1)
  })

  it('returns before a slow command settles and contains its later rejection', async () => {
    const test = await harness(true)
    const sender = test.root('sender')
    const target = test.root('target')
    let rejectHandler!: (error: Error) => void
    test.ctx.commands.register({
      name: 'compact',
      description: 'test command',
      handler: () => new Promise((_resolve, reject) => { rejectHandler = reject }),
    })
    const warn = vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => undefined)

    await expect(test.registry.send({
      caller: sender.agent,
      peer: target.agent.id,
      message: '/compact',
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      kind: 'command',
      command: { peerSessionId: target.agent.id, name: 'compact' },
    })
    expect(target.received).toEqual([])

    rejectHandler(new Error('late handler rejection'))
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'peer command execution rejected after dispatch: Error: late handler rejection',
      )
    })
  })

  it('hides archived roots from listing and refuses addressing them', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const archived = test.root('archived')

    expect(test.registry.list(sender.agent)).toHaveLength(1)
    test.archive(archived.agent.id)

    expect(test.registry.list(sender.agent)).toEqual([])
    await expect(test.registry.send({ caller: sender.agent, peer: archived.agent.id, message: 'hidden' }))
      .rejects.toMatchObject({ code: 'PEER_ARCHIVED' })
    expect(archived.received).toEqual([])
  })

  it('refuses interaction-blocked delivery, allows peer-only delivery, and records minimal attribution', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const target = test.root('target')
    const peerLease = test.ctx.agentWaits.acquire({ lifetime: { kind: 'agent', agent: target.agent }, reason: 'peer' })

    await expect(test.registry.send({ caller: sender.agent, peer: target.agent.id, message: 'peer-only' }))
      .resolves.toMatchObject({ delivery: { peerSessionId: target.agent.id } })
    expect(target.received.at(-1)?.source).toEqual(expect.objectContaining({
      kind: 'peer', senderSessionId: sender.agent.id,
    }))
    expect(target.received.at(-1)?.source).not.toHaveProperty('groupId')
    expect(target.received.at(-1)?.source).not.toHaveProperty('senderIncarnation')

    const interaction = test.ctx.agentWaits.acquire({ lifetime: { kind: 'agent', agent: target.agent }, reason: 'interaction' })
    expect(test.registry.list(sender.agent)[0]?.execution).toEqual({ state: 'blocked', reason: 'interaction' })
    await expect(test.registry.send({ caller: sender.agent, peer: target.agent.id, message: 'blocked' }))
      .rejects.toMatchObject({ code: 'PEER_BLOCKED_INTERACTION' })
    interaction.release()
    peerLease.release()
  })

  it('pins the resolved Agent while a mid-wait rename neither retargets nor fails the wait', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    rename(target.agent.session, 'reviewer')
    target.setStatus('running')
    const waiting = test.registry.wait({ caller: waiter.agent, peer: 'reviewer', wait: spec(['idle']) })

    rename(target.agent.session, 'renamed')
    target.setStatus('idle')

    await expect(waiting).resolves.toMatchObject({ peerSessionId: target.agent.id, execution: { state: 'idle' } })
  })

  it('rejects a replacement Agent generation without transferring the wait', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    const waiting = test.registry.wait({ caller: waiter.agent, peer: target.agent.id, wait: spec(['working']) })

    target.detach()
    const replacement = { ...target.agent, status: 'running' } as Agent
    test.ctx.agents.enter(replacement, undefined)
    test.ctx.emit('agent/status', { agent: replacement, status: 'running' })

    await expect(waiting).rejects.toMatchObject({ code: 'PEER_REPLACED' })
    expect(internalSize(test.registry, 'edges')).toBe(0)
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('distinguishes inactive and replaced pinned targets during reauthorization', async () => {
    const unavailable = await harness()
    const absent = unavailable.root('absent')
    const pinnedAbsent = { sessionId: absent.agent.id, agent: absent.agent }
    absent.detach()
    expect(() => callPrivate(unavailable.registry, 'requirePinnedPeer', [pinnedAbsent]))
      .toThrow(expect.objectContaining({ code: 'PEER_UNAVAILABLE' }))

    const replaced = await harness()
    const stale = replaced.root('stale')
    const pinnedStale = { sessionId: stale.agent.id, agent: stale.agent }
    stale.detach()
    replaced.ctx.agents.enter({ ...stale.agent }, undefined)
    expect(() => callPrivate(replaced.registry, 'requirePinnedPeer', [pinnedStale]))
      .toThrow(expect.objectContaining({ code: 'PEER_REPLACED' }))
  })

  it('fails delivery when canonical workspace identity cannot be resolved', async () => {
    const test = await harness()
    const sender = test.root('sender', '/definitely/missing/dsh-peer-workspace')
    const target = test.root('target', '/definitely/missing/dsh-peer-workspace')

    await expect(test.registry.send({ caller: sender.agent, peer: target.agent.id, message: 'no path' }))
      .rejects.toThrow("cannot resolve canonical workspace for session 'sender'")
  })

  it('cleans the graph when wait-lease acquisition fails before a wait record exists', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    vi.spyOn(test.ctx.agentWaits, 'acquire').mockImplementationOnce(() => { throw new Error('lease failed') })

    await expect(test.registry.wait({ caller: waiter.agent, peer: target.agent.id, wait: spec(['working']) }))
      .rejects.toThrow('lease failed')
    expect(internalSize(test.registry, 'edges')).toBe(0)
  })

  it('fails closed when an impossible delivery settlement lacks a claimed turn', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const target = test.root('target')
    Reflect.set(test.registry, 'runWait', () => Promise.resolve({
      waitId: 'synthetic-wait',
      peerSessionId: target.agent.id,
      execution: { state: 'idle' },
    }))

    await expect(test.registry.send({
      caller: sender.agent, peer: target.agent.id, message: 'synthetic', wait: spec(['idle']),
    })).rejects.toMatchObject({ code: 'SUBSCRIPTION_FAILED' })
  })

  it('settles a delivery wait only from its own claimed turn', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const target = test.root('target')
    const sent = test.registry.send({
      caller: sender.agent,
      peer: target.agent.id,
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

  it('requires an idle claimed delivery turn to end before settling', async () => {
    const test = await harness()
    const sender = test.root('sender')
    const target = test.root('target')
    const sent = test.registry.send({
      caller: sender.agent, peer: target.agent.id, message: 'idle claim', wait: spec(['idle']),
    })
    const delivered = target.received[0]
    expect(delivered).toBeDefined()
    test.ctx.emit('agent/inbox/claimed', { agent: target.agent, message: delivered as UserMessage, turn: 2 })
    let settled = false
    void sent.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    target.agent.session.append('turn/start', { turn: 2 })
    target.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await expect(sent).resolves.toMatchObject({ settled: { turn: 2, execution: { state: 'idle' } } })
  })

  it('detects cycles across the process and releases graph state after abort', async () => {
    const test = await harness()
    const first = test.root('first')
    const second = test.root('second')
    const controller = new AbortController()
    const firstWait = test.registry.wait({
      caller: first.agent,
      peer: second.agent.id,
      wait: spec(['working']),
      signal: controller.signal,
    })

    await expect(test.registry.wait({
      caller: second.agent,
      peer: first.agent.id,
      wait: spec(['working']),
    })).rejects.toMatchObject({ code: 'WAIT_CYCLE' })
    controller.abort()
    await expect(firstWait).rejects.toMatchObject({ code: 'WAIT_ABORTED' })
    expect(internalSize(test.registry, 'edges')).toBe(0)
    expect(test.ctx.agentWaits.snapshot().leases).toEqual([])
  })

  it('walks converging process-wide wait edges without revisiting a vertex', async () => {
    const test = await harness()
    const first = test.root('first')
    const second = test.root('second')
    const third = test.root('third')
    const fourth = test.root('fourth')
    const firstController = new AbortController()
    const secondController = new AbortController()
    const thirdController = new AbortController()
    const fourthController = new AbortController()
    const waits = [
      test.registry.wait({ caller: first.agent, peer: second.agent.id, wait: spec(['working']), signal: firstController.signal }),
      test.registry.wait({ caller: first.agent, peer: third.agent.id, wait: spec(['working']), signal: secondController.signal }),
      test.registry.wait({ caller: second.agent, peer: third.agent.id, wait: spec(['working']), signal: thirdController.signal }),
      test.registry.wait({ caller: fourth.agent, peer: first.agent.id, wait: spec(['working']), signal: fourthController.signal }),
    ]
    firstController.abort()
    secondController.abort()
    thirdController.abort()
    fourthController.abort()
    await Promise.all(waits.map(wait => expect(wait).rejects.toMatchObject({ code: 'WAIT_ABORTED' })))
  })

  it('distinguishes a stalled delivery effect from the shorter user timeout', async () => {
    vi.useFakeTimers()
    try {
      const test = await harness()
      const sender = test.root('sender')
      const target = test.root('target')
      const stalledCode = errorCode(test.registry.send({
        caller: sender.agent,
        peer: target.agent.id,
        message: 'stalled',
        wait: spec(['idle'], 6_000),
      }))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await stalledCode).toBe('PROMPT_STALLED')

      const timeoutCode = errorCode(test.registry.send({
        caller: sender.agent,
        peer: target.agent.id,
        message: 'timeout',
        wait: spec(['idle'], 4_000),
      }))
      await vi.advanceTimersByTimeAsync(4_000)
      expect(await timeoutCode).toBe('WAIT_TIMEOUT')
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a standalone wait after the full bound', async () => {
    vi.useFakeTimers()
    try {
      const test = await harness()
      const waiter = test.root('waiter')
      const target = test.root('target')
      const waiting = test.registry.wait({ caller: waiter.agent, peer: target.agent.id, wait: spec(['working']) })
      const code = errorCode(waiting)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await code).toBe('WAIT_TIMEOUT')
    } finally {
      vi.useRealTimers()
    }
  })

  it('revalidates silently removed waiter and target roots during observation', async () => {
    const missingWaiter = await harness()
    const waiter = missingWaiter.root('waiter')
    const target = missingWaiter.root('target')
    const waiterPromise = missingWaiter.registry.wait({
      caller: waiter.agent, peer: target.agent.id, wait: spec(['working']),
    })
    waiter.detach()
    callPrivate(missingWaiter.registry, 'notifyAllWaits')
    await expect(waiterPromise).rejects.toMatchObject({ code: 'WAIT_ABORTED' })

    const missingTarget = await harness()
    const otherWaiter = missingTarget.root('waiter')
    const otherTarget = missingTarget.root('target')
    const targetPromise = missingTarget.registry.wait({
      caller: otherWaiter.agent, peer: otherTarget.agent.id, wait: spec(['working']),
    })
    otherTarget.detach()
    callPrivate(missingTarget.registry, 'notifyAllWaits')
    await expect(targetPromise).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' })
  })

  it('ignores repeated settlement and refreshes the wait projection', async () => {
    const test = await harness()
    const waiter = test.root('waiter')
    const target = test.root('target')
    const unrelated = test.root('unrelated')
    const waiting = test.registry.wait({ caller: waiter.agent, peer: target.agent.id, wait: spec(['working']) })
    const record = [...(Reflect.get(test.registry, 'waits') as Map<unknown, unknown>).values()][0]
    expect(record).toBeDefined()
    unrelated.setStatus('running')
    test.ctx.emit('agent/disposed', { agent: unrelated.agent })
    const timeoutTimer = Reflect.get(record as object, 'timeoutTimer') as ReturnType<typeof setTimeout>
    clearTimeout(timeoutTimer)
    Reflect.set(record as object, 'timeoutTimer', undefined)
    callPrivate(test.registry, 'failWait', [record, 'WAIT_ABORTED', 'first'])
    callPrivate(test.registry, 'failWait', [record, 'WAIT_ABORTED', 'second'])
    await expect(waiting).rejects.toMatchObject({ code: 'WAIT_ABORTED', message: 'first' })

    const lease = test.ctx.agentWaits.acquire({ lifetime: { kind: 'agent', agent: unrelated.agent }, reason: 'peer' })
    const snapshot = test.ctx.agentWaits.snapshot()
    Reflect.set(test.agentWaitRegistry, 'changes', () => ({ kind: 'refresh', snapshot }))
    callPrivate(test.registry, 'drainWaitChanges')
    const [view] = snapshot.leases
    expect(view).toBeDefined()
    callPrivate(test.registry, 'applyWaitTransition', [{
      kind: 'ended', cursor: snapshot.cursor, lease: view, termination: 'released',
    }])
    lease.release()
  })

  it('rejects calls through a disposed provider and makes repeated disposal inert', async () => {
    const test = await harness()
    const caller = test.root('caller')
    await test.fiber.dispose()
    expect(() => test.registry.list(caller.agent)).toThrow(expect.objectContaining({ code: 'PROVIDER_DISPOSED' }))
    callPrivate(test.registry, 'drainWaitChanges')
    callPrivate(test.registry, 'disposeState')
  })

  it('ends waits for root disposal, observation failure, and provider disposal', async () => {
    const waiterDisposed = await harness()
    const removedWaiter = waiterDisposed.root('waiter')
    const waiterTarget = waiterDisposed.root('target')
    const aborted = waiterDisposed.registry.wait({
      caller: removedWaiter.agent, peer: waiterTarget.agent.id, wait: spec(['working']),
    })
    waiterDisposed.ctx.emit('agent/disposed', { agent: removedWaiter.agent })
    await expect(aborted).rejects.toMatchObject({ code: 'WAIT_ABORTED' })

    const disposed = await harness()
    const disposedWaiter = disposed.root('waiter')
    const disposedTarget = disposed.root('target')
    const unavailable = disposed.registry.wait({
      caller: disposedWaiter.agent, peer: disposedTarget.agent.id, wait: spec(['working']),
    })
    disposed.ctx.emit('agent/disposed', { agent: disposedTarget.agent })
    await expect(unavailable).rejects.toMatchObject({ code: 'PEER_UNAVAILABLE' })

    const failed = await harness()
    const failedWaiter = failed.root('waiter')
    const failedTarget = failed.root('target')
    const observation = failed.registry.wait({
      caller: failedWaiter.agent, peer: failedTarget.agent.id, wait: spec(['working']),
    })
    Reflect.set(failed.agentWaitRegistry, 'changes', () => { throw new Error('observation failed') })
    Reflect.apply(Reflect.get(failed.registry, 'drainWaitChanges') as () => void, failed.registry, [])
    await expect(observation).rejects.toMatchObject({ code: 'SUBSCRIPTION_FAILED' })

    const unloaded = await harness()
    const unloadedWaiter = unloaded.root('waiter')
    const unloadedTarget = unloaded.root('target')
    const provider = unloaded.registry.wait({
      caller: unloadedWaiter.agent, peer: unloadedTarget.agent.id, wait: spec(['working']),
    })
    await unloaded.fiber.dispose()
    await expect(provider).rejects.toMatchObject({ code: 'PROVIDER_DISPOSED' })
    expect(unloaded.ctx.get('peers')).toBeUndefined()
  })
})
