import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import {
  PeerDeliveryId,
  PeerGroupId,
  PeerGroupRegistry,
  PeerMembershipIncarnation,
  PeerWaitId,
} from '@deepseek-ai/dsh-peer-group'
import type {
  PeerGroupView,
  PeerMemberView,
  PeerSendRequest,
  PeerSendResult,
  PeerWaitObservation,
  PeerWaitOptions,
  PeerWaitRequest,
  PeerWaitSpec,
} from '@deepseek-ai/dsh-peer-group'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as toolPeer from '@deepseek-ai/dsh-tool-peer'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const CALLER_ID = SessionId('caller')
const TARGET_ID = SessionId('target')
const GROUP_ID = PeerGroupId('team')
const INCARNATION = PeerMembershipIncarnation('member-1')

const TARGET: PeerMemberView = {
  groupId: GROUP_ID,
  sessionId: TARGET_ID,
  incarnation: INCARNATION,
  title: 'Research peer',
  workspace: 'workspace',
  availability: 'live',
  execution: { state: 'idle' },
  writeAccess: 'read-only',
}

const GROUP: PeerGroupView = {
  id: GROUP_ID,
  name: GROUP_ID,
  members: [TARGET],
}

class StubPeerGroupRegistry extends PeerGroupRegistry {
  readonly resolveCalls: PeerWaitOptions[] = []
  readonly sendCalls: PeerSendRequest[] = []
  readonly waitCalls: PeerWaitRequest[] = []
  groups: readonly PeerGroupView[] = [GROUP]

  override resolveWait(options: PeerWaitOptions = {}): PeerWaitSpec {
    this.resolveCalls.push(options)
    return { until: options.until as PeerWaitSpec['until'] ?? ['idle', 'blocked'], timeoutMs: options.timeoutMs ?? 300_000 }
  }

  override create(): Promise<PeerGroupView> {
    return Promise.reject(new Error('unused'))
  }

  override add(): Promise<PeerMemberView> {
    return Promise.reject(new Error('unused'))
  }

  override remove(): Promise<void> {
    return Promise.reject(new Error('unused'))
  }

  override dissolve(): Promise<void> {
    return Promise.reject(new Error('unused'))
  }

  override list(): readonly PeerGroupView[] {
    return this.groups
  }

  override send(request: PeerSendRequest): Promise<PeerSendResult> {
    this.sendCalls.push(request)
    return Promise.resolve({
      delivery: {
        deliveryId: PeerDeliveryId('delivery-1'),
        messageId: MessageId('message-1'),
        peer: { groupId: GROUP_ID, sessionId: TARGET_ID, incarnation: INCARNATION },
      },
      ...request.wait === undefined ? {} : {
        settled: {
          waitId: PeerWaitId('wait-1'),
          peer: { groupId: GROUP_ID, sessionId: TARGET_ID, incarnation: INCARNATION },
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
      peer: { groupId: GROUP_ID, sessionId: TARGET_ID, incarnation: INCARNATION },
      execution: { state: 'blocked', reason: 'peer' },
    })
  }
}

interface Harness {
  readonly ctx: Context
  readonly registry: StubPeerGroupRegistry
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  const registry = new StubPeerGroupRegistry(ctx)
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
      peer: { session: TARGET_ID }, message: 'check status',
    })).toEqual({ card: 'generic', title: `Send to peer ${TARGET_ID}`, kind: 'other', rawInput: 'check status' })
    expect(test.ctx.tools.get('wait_for_peer')?.presentCall?.({ peer: { session: TARGET_ID } }))
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
  it('validates arguments before calling the Service', async () => {
    const test = await harness()
    const missingPeer = await execute(test, 'send_to_peer', { message: 'hello' })
    expect(missingPeer.isError).toBe(true)
    const badWait = await execute(test, 'send_to_peer', {
      peer: { session: TARGET_ID }, message: 'hello', wait: { until: ['finished'] },
    })
    expect(badWait.isError).toBe(true)
    const extraWaitField = await execute(test, 'send_to_peer', {
      peer: { session: TARGET_ID }, message: 'hello', wait: { timeout: 5 },
    })
    expect(extraWaitField.isError).toBe(true)
    expect(test.registry.sendCalls).toHaveLength(0)
  })

  it('returns acceptance without a reply and does not resolve a wait when wait is absent', async () => {
    const test = await harness()
    const result = await execute(test, 'send_to_peer', {
      peer: { group: GROUP_ID, session: TARGET_ID }, message: 'review this',
    })
    expect(result.isError).toBe(false)
    expect(jsonResult(result)).toEqual({
      accepted: true,
      deliveryId: 'delivery-1',
      messageId: 'message-1',
      peer: { group: GROUP_ID, session: TARGET_ID },
    })
    expect(JSON.stringify(jsonResult(result))).not.toContain('reply')
    expect(test.registry.resolveCalls).toEqual([])
    expect(test.registry.sendCalls[0]?.wait).toBeUndefined()
  })

  it('routes an explicit delivery wait through resolveWait', async () => {
    const test = await harness()
    const result = await execute(test, 'send_to_peer', {
      peer: { session: TARGET_ID },
      message: 'finish this',
      wait: { until: ['idle'], timeoutMs: 2_000 },
    })
    expect(result.isError).toBe(false)
    expect(test.registry.resolveCalls).toEqual([{ until: ['idle'], timeoutMs: 2_000 }])
    expect(test.registry.sendCalls[0]?.wait).toEqual({ until: ['idle'], timeoutMs: 2_000 })
    expect(jsonResult(result)).toMatchObject({ wait: { state: 'idle', turn: 4 } })
  })

  it('uses standalone state observation for wait_for_peer', async () => {
    const test = await harness()
    const result = await execute(test, 'wait_for_peer', {
      peer: { group: GROUP_ID, session: TARGET_ID }, until: ['blocked'],
    })
    expect(result.isError).toBe(false)
    expect(test.registry.resolveCalls).toEqual([{ until: ['blocked'] }])
    expect(test.registry.waitCalls).toHaveLength(1)
    expect(jsonResult(result)).toEqual({
      peer: { group: GROUP_ID, session: TARGET_ID }, state: 'blocked', blockedReason: 'peer',
    })
  })

  it('lists model-relevant peer rows and rejects mutually exclusive selectors', async () => {
    const test = await harness()
    const result = await execute(test, 'list_peers', { group: GROUP_ID })
    expect(result.isError).toBe(false)
    expect(jsonResult(result)).toEqual([{
      group: GROUP_ID,
      session: TARGET_ID,
      title: 'Research peer',
      workspace: 'workspace',
      availability: 'live',
      state: 'idle',
      writeAccess: 'read-only',
    }])
    const invalid = await execute(test, 'list_peers', {
      group: GROUP_ID, peer: { session: TARGET_ID },
    })
    expect(invalid.isError).toBe(true)
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
