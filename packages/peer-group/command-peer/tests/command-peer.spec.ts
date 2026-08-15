import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import LocalAgentWaitRegistry from '@deepseek-ai/dsh-agent-wait-local'
import * as commandPeer from '@deepseek-ai/dsh-command-peer'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LocalPeerGroupRegistry from '@deepseek-ai/dsh-peer-group-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

interface Harness {
  readonly ctx: Context
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
  root(id: string, cwd: string): Agent
}

/** Mount the real command registry and peer-group implementation. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: '/tmp' })
  await ctx.plugin(LocalAgentWaitRegistry, { retainedTransitionLimit: 32 })
  await ctx.plugin(LocalPeerGroupRegistry, {
    defaultWaitTimeoutMs: 1_000,
    maxWaitTimeoutMs: 10_000,
  })
  const plugin = await ctx.plugin(commandPeer)
  return {
    ctx,
    plugin,
    root(id, cwd) {
      const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
      let status: AgentStatus = 'idle'
      const agent = {
        id: session.id,
        options: {},
        session,
        inbox: {},
        ctx,
        get status() { return status },
        cancel() { status = 'idle' },
        whenIdle: () => Promise.resolve(),
        runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
        send() {},
        followup() {},
        steer() {},
        inject() {},
      } as unknown as Agent
      ctx.agents.enter(agent, undefined)
      return agent
    },
  }
}

/** Execute `/peer` through the human-command registry. */
async function run(test: Harness, agent: Agent, input: string): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>['result']> {
  const execution = await test.ctx.commands.execute(
    agent,
    `/peer${input}`,
    new AbortController().signal,
  )
  if (execution === undefined) throw new Error('/peer was not registered')
  return execution.result
}

describe('@deepseek-ai/dsh-command-peer', () => {
  it('registers the exact command metadata and unregisters on disposal', async () => {
    const test = await harness()
    const agent = test.root('caller', '/tmp')
    expect(commandPeer.name).toBe('command-peer')
    expect(commandPeer.inject).toEqual(['commands', 'peerGroups'])
    expect('default' in commandPeer).toBe(false)
    expect((Object.create(Loader.prototype) as Loader).unwrapExports(commandPeer)).toBe(commandPeer)
    expect(test.ctx.commands.list(agent)).toContainEqual({
      name: 'peer',
      description: 'Create, inspect, and change peer groups',
      input: { hint: 'create|add|remove|list|dissolve ...' },
    })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(agent, 'peer')).toBeUndefined()
  })

  it('creates, adds, lists, removes, and dissolves through the exact grammar', async () => {
    const test = await harness()
    const first = test.root('first', '/tmp')
    test.root('second', '/')

    await expect(run(test, first, ' create team')).resolves.toMatchObject({ kind: 'success' })
    await expect(run(test, first, ' add team second')).resolves.toEqual({
      kind: 'success', text: "Added 'second' to peer group 'team'.",
    })
    const listed = await run(test, first, ' list team')
    expect(listed.kind).toBe('success')
    expect(listed.text).toContain('Peer group team')
    expect(listed.text).toContain('(first) · workspace=tmp · availability=live · status=idle')
    expect(listed.text).toContain('(second) · workspace=/ · availability=live · status=idle')
    await expect(run(test, first, ' remove team second')).resolves.toEqual({
      kind: 'success', text: "Removed 'second' from peer group 'team'.",
    })
    await expect(run(test, first, ' dissolve team')).resolves.toEqual({
      kind: 'success', text: "Dissolved peer group 'team'.",
    })
    await expect(run(test, first, ' list')).resolves.toEqual({ kind: 'success', text: 'No peer groups.' })
  })

  it('rejects invalid names at the command and refuses malformed grammar', async () => {
    const test = await harness()
    const caller = test.root('caller', '/tmp')
    const invalidName = await run(test, caller, ' create Upper')
    expect(invalidName.kind).toBe('error')
    expect(invalidName.text).toContain('BAD_GROUP_NAME')
    const malformed = await run(test, caller, ' add only-group')
    expect(malformed.kind).toBe('error')
    expect(malformed.text).toContain('Usage:')
  })

  it('reports non-member, unknown group, unknown session, and second-writer rejections', async () => {
    const test = await harness()
    const member = test.root('member', '/tmp')
    const outsider = test.root('outsider', '/')
    test.root('same-writer', '/tmp')
    await run(test, member, ' create guard')

    const nonMember = await run(test, outsider, ' list guard')
    expect(nonMember.text).toContain('CALLER_NOT_MEMBER')
    const unknownGroup = await run(test, member, ' list missing')
    expect(unknownGroup.text).toContain('GROUP_NOT_FOUND')
    const unknownSession = await run(test, member, ' add guard unknown')
    expect(unknownSession.text).toContain('MEMBER_NOT_ROOT')
    const secondWriter = await run(test, member, ' add guard same-writer')
    expect(secondWriter.text).toContain('SECOND_WRITER')
  })
})
