import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import {
  PeerDeliveryId,
  PeerRegistry,
  PeerWaitId,
} from '@deepseek-ai/dsh-peer'
import type {
  PeerSendRequest,
  PeerSendResult,
  PeerView,
  PeerWaitObservation,
  PeerWaitOptions,
  PeerWaitRequest,
  PeerWaitSpec,
} from '@deepseek-ai/dsh-peer'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolPeer from '@deepseek-ai/dsh-tool-peer'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const CALLER_ID = SessionId('caller')
const TARGET_ID = SessionId('target')

const TARGET: PeerView = {
  sessionId: TARGET_ID,
  title: 'Research peer',
  titleSource: 'user',
  workspace: 'workspace',
  preset: 'reviewer',
  execution: { state: 'idle' },
  writeAccess: 'read-only',
}

class StubPeerRegistry extends PeerRegistry {
  readonly resolveCalls: PeerWaitOptions[] = []
  readonly sendCalls: PeerSendRequest[] = []
  readonly waitCalls: PeerWaitRequest[] = []
  peers: readonly PeerView[] = [TARGET]
  shareWorkspace = false

  override resolveWait(options: PeerWaitOptions = {}): PeerWaitSpec {
    this.resolveCalls.push(options)
    return { until: options.until as PeerWaitSpec['until'] ?? ['idle', 'blocked'], timeoutMs: options.timeoutMs ?? 300_000 }
  }

  override list(): readonly PeerView[] {
    return this.peers
  }

  override send(request: PeerSendRequest): Promise<PeerSendResult> {
    this.sendCalls.push(request)
    return Promise.resolve({
      kind: 'message',
      delivery: {
        deliveryId: PeerDeliveryId('delivery-1'),
        messageId: MessageId('message-1'),
        peerSessionId: TARGET_ID,
        ...this.shareWorkspace ? { sharesWritableWorkspace: true as const } : {},
      },
      ...request.wait === undefined ? {} : {
        settled: {
          waitId: PeerWaitId('wait-1'),
          peerSessionId: TARGET_ID,
          execution: { state: 'idle' },
          turn: 4,
        },
      },
    })
  }

  override wait(request: PeerWaitRequest): Promise<PeerWaitObservation> {
    this.waitCalls.push(request)
    return Promise.resolve({
      waitId: PeerWaitId('wait-2'),
      peerSessionId: TARGET_ID,
      execution: { state: 'blocked', reason: 'peer' },
    })
  }
}

interface Harness {
  readonly ctx: Context
  readonly registry: StubPeerRegistry
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  const registry = new StubPeerRegistry(ctx)
  const plugin = await ctx.plugin(toolPeer)
  const session = Session.create(CALLER_ID)
  const agent = { id: CALLER_ID, session, status: 'idle', options: {}, ctx } as unknown as Agent
  return { ctx, registry, agent, plugin }
}

async function execute(test: Harness, name: string, args: unknown) {
  return test.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`${name}-${Math.random()}`),
    name,
    arguments: args,
    agent: test.agent,
  })
}

function jsonResult(result: Awaited<ReturnType<typeof execute>>): unknown {
  const text = result.content.find(block => block.type === 'text')?.text
  if (text === undefined) throw new Error('tool result has no text block')
  return JSON.parse(text)
}

describe('@deepseek-ai/dsh-tool-peer registration', () => {
  it('registers three generic-presented tools and disposes all registrations', async () => {
    const test = await harness()
    expect(test.ctx.tools.schemas().map(schema => schema.name)).toEqual([
      'send_to_peer', 'wait_for_peer', 'list_peers',
    ])
    expect(test.ctx.tools.get('send_to_peer')?.presentCall?.({
      peer: TARGET_ID, message: 'check status',
    })).toEqual({ card: 'generic', title: `Send to peer ${TARGET_ID}`, kind: 'other', rawInput: 'check status' })
    expect(test.ctx.tools.get('wait_for_peer')?.presentCall?.({ peer: TARGET_ID }))
      .toEqual({ card: 'generic', title: `Wait for peer ${TARGET_ID}`, kind: 'other' })
    expect(test.ctx.tools.get('list_peers')?.presentCall?.({}))
      .toEqual({ card: 'generic', title: 'List peers', kind: 'other' })

    await test.plugin.dispose()
    expect(test.ctx.tools.get('send_to_peer')).toBeUndefined()
    expect(test.ctx.tools.get('wait_for_peer')).toBeUndefined()
    expect(test.ctx.tools.get('list_peers')).toBeUndefined()
  })
})

describe('peer tools', () => {
  it('validates string peer arguments before calling the Service', async () => {
    const test = await harness()
    const missingPeer = await execute(test, 'send_to_peer', { message: 'hello' })
    expect(missingPeer.isError).toBe(true)
    const objectPeer = await execute(test, 'send_to_peer', {
      peer: { session: TARGET_ID }, message: 'hello',
    })
    expect(objectPeer.isError).toBe(true)
    const badWait = await execute(test, 'send_to_peer', {
      peer: TARGET_ID, message: 'hello', wait: { until: ['finished'] },
    })
    expect(badWait.isError).toBe(true)
    expect(test.registry.sendCalls).toHaveLength(0)
  })

  it('returns acceptance without a reply and does not resolve a wait when wait is absent', async () => {
    const test = await harness()
    const result = await execute(test, 'send_to_peer', { peer: 'Research peer', message: 'review this' })
    expect(result.isError).toBe(false)
    expect(jsonResult(result)).toEqual({
      accepted: true,
      deliveryId: 'delivery-1',
      messageId: 'message-1',
      peer: TARGET_ID,
    })
    expect(JSON.stringify(jsonResult(result))).not.toContain('reply')
    expect(test.registry.resolveCalls).toEqual([])
    expect(test.registry.sendCalls[0]?.peer).toBe('Research peer')
    expect(test.registry.sendCalls[0]).not.toHaveProperty('wait')
  })

  it('routes an explicit delivery wait through resolveWait', async () => {
    const test = await harness()
    const result = await execute(test, 'send_to_peer', {
      peer: TARGET_ID,
      message: 'finish this',
      wait: { until: ['idle'], timeoutMs: 2_000 },
    })
    expect(result.isError).toBe(false)
    expect(test.registry.resolveCalls).toEqual([{ until: ['idle'], timeoutMs: 2_000 }])
    expect(test.registry.sendCalls[0]?.wait).toEqual({ until: ['idle'], timeoutMs: 2_000 })
    expect(jsonResult(result)).toMatchObject({ wait: { state: 'idle', turn: 4 } })
  })

  it('projects command dispatch and uses a state-only wait without a turn', async () => {
    const test = await harness()
    test.registry.send = async (request) => {
      test.registry.sendCalls.push(request)
      return {
        kind: 'command',
        command: {
          peerSessionId: TARGET_ID,
          name: 'compact',
        },
        ...request.wait === undefined ? {} : {
          settled: {
            waitId: PeerWaitId('command-wait'),
            peerSessionId: TARGET_ID,
            execution: { state: 'idle' },
          },
        },
      }
    }

    const immediate = await execute(test, 'send_to_peer', { peer: TARGET_ID, message: '/compact' })
    expect(jsonResult(immediate)).toEqual({
      accepted: true,
      ranAsCommand: 'compact',
      peer: TARGET_ID,
    })

    const waited = await execute(test, 'send_to_peer', {
      peer: TARGET_ID,
      message: '/compact',
      wait: { until: ['idle'] },
    })
    expect(jsonResult(waited)).toEqual({
      accepted: true,
      ranAsCommand: 'compact',
      peer: TARGET_ID,
      wait: { state: 'idle' },
    })
  })

  it('projects blocked delivery waits and independently omitted wait options', async () => {
    const test = await harness()
    test.registry.send = async (request) => {
      test.registry.sendCalls.push(request)
      return {
        kind: 'message',
        delivery: {
          deliveryId: PeerDeliveryId('delivery-blocked'),
          messageId: MessageId('message-blocked'),
          peerSessionId: TARGET_ID,
        },
        settled: {
          waitId: PeerWaitId('wait-blocked'),
          peerSessionId: TARGET_ID,
          execution: { state: 'blocked', reason: 'interaction' },
          turn: 5,
        },
      }
    }
    const untilOnly = await execute(test, 'send_to_peer', {
      peer: TARGET_ID, message: 'blocked', wait: { until: ['blocked'] },
    })
    expect(jsonResult(untilOnly)).toMatchObject({ wait: { state: 'blocked', blockedReason: 'interaction', turn: 5 } })
    expect(test.registry.resolveCalls).toEqual([{ until: ['blocked'] }])

    const timeoutOnly = await execute(test, 'send_to_peer', {
      peer: TARGET_ID, message: 'bounded', wait: { timeoutMs: 500 },
    })
    expect(timeoutOnly.isError).toBe(false)
    expect(test.registry.resolveCalls[1]).toEqual({ timeoutMs: 500 })
  })

  it('uses standalone state observation for wait_for_peer', async () => {
    const test = await harness()
    const result = await execute(test, 'wait_for_peer', { peer: TARGET_ID, until: ['blocked'] })
    expect(result.isError).toBe(false)
    expect(test.registry.resolveCalls).toEqual([{ until: ['blocked'] }])
    expect(test.registry.waitCalls).toHaveLength(1)
    expect(jsonResult(result)).toEqual({ peer: TARGET_ID, state: 'blocked', blockedReason: 'peer' })
  })

  it('projects an unblocked standalone observation and provider defaults', async () => {
    const test = await harness()
    test.registry.wait = async (request) => {
      test.registry.waitCalls.push(request)
      return {
        waitId: PeerWaitId('wait-idle'),
        peerSessionId: TARGET_ID,
        execution: { state: 'idle' },
      }
    }
    const result = await execute(test, 'wait_for_peer', { peer: TARGET_ID })
    expect(jsonResult(result)).toEqual({ peer: TARGET_ID, state: 'idle' })
    expect(test.registry.resolveCalls).toEqual([{}])

    const bounded = await execute(test, 'wait_for_peer', { peer: TARGET_ID, timeoutMs: 750 })
    expect(bounded.isError).toBe(false)
    expect(test.registry.resolveCalls[1]).toEqual({ timeoutMs: 750 })
  })

  it('lists active-root fields including addressable title provenance and preset', async () => {
    const test = await harness()
    const result = await execute(test, 'list_peers', {})
    expect(result.isError).toBe(false)
    expect(jsonResult(result)).toEqual([{
      session: TARGET_ID,
      title: 'Research peer',
      titleSource: 'user',
      workspace: 'workspace',
      preset: 'reviewer',
      state: 'idle',
      writeAccess: 'read-only',
    }])
  })

  it('omits absent optional projection fields and includes blocked reason', async () => {
    const test = await harness()
    test.registry.peers = [{
      sessionId: TARGET_ID,
      execution: { state: 'blocked', reason: 'peer' },
      writeAccess: 'write-capable',
    }]
    const result = await execute(test, 'list_peers', {})
    expect(jsonResult(result)).toEqual([{
      session: TARGET_ID,
      state: 'blocked',
      blockedReason: 'peer',
      writeAccess: 'write-capable',
    }])
  })

  it('surfaces a shared writable workspace on both listing and delivery', async () => {
    const test = await harness()
    test.registry.peers = [{ ...TARGET, writeAccess: 'write-capable', sharesWritableWorkspace: true }]
    test.registry.shareWorkspace = true

    const listed = jsonResult(await execute(test, 'list_peers', {}))
    expect(listed).toEqual([expect.objectContaining({ sharesWritableWorkspace: true })])

    const sent = jsonResult(await execute(test, 'send_to_peer', { peer: TARGET_ID, message: 'edit' }))
    expect(sent).toEqual(expect.objectContaining({ accepted: true, sharesWritableWorkspace: true }))
  })

  it('requires a calling Agent before invoking peer authority', async () => {
    const test = await harness()
    const result = await test.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('agentless'),
      name: 'list_peers',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content.filter(block => block.type === 'text').map(block => block.text).join(''))
      .toContain('peer tools require a calling agent')
  })
})
