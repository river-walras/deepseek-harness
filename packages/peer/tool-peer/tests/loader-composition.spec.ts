import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentWaitInteraction from '@deepseek-ai/dsh-agent-wait-interaction'
import LocalAgentWaitRegistry from '@deepseek-ai/dsh-agent-wait-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as PeerInvariant from '@deepseek-ai/dsh-peer/invariant'
import LocalPeerRegistry from '@deepseek-ai/dsh-peer-local'
import * as PeerLocalInvariant from '@deepseek-ai/dsh-peer-local/invariant'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolPeer from '@deepseek-ai/dsh-tool-peer'
import ToolRuntime from '@deepseek-ai/dsh-tools'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Create a real root Agent registered in the composed runtime. */
function rootAgent(ctx: Context, id: string, cwd: string): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx,
    status: 'idle',
    cancel() {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: <T>(task: (signal: AbortSignal) => Promise<T>) => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  } as unknown as Agent
  ctx.agents.enter(agent, undefined)
  return agent
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('peer collaboration real Loader composition', () => {
  it('boots a cordis.yml and discovers another active root without formation', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-peer-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-invariants'",
      '  config:',
      '    enabled: true',
      "- name: '@deepseek-ai/dsh-agent-wait-local'",
      '  config:',
      '    retainedTransitionLimit: 512',
      "- name: '@deepseek-ai/dsh-agent-wait-interaction'",
      "- name: '@deepseek-ai/dsh-sandbox-policy'",
      '  config:',
      '    mode: workspace-write',
      '    workspaceRoot: /tmp',
      "- name: '@deepseek-ai/dsh-peer-local'",
      '  config:',
      '    defaultWaitTimeoutMs: 300000',
      '    maxWaitTimeoutMs: 1800000',
      "- name: '@deepseek-ai/dsh-peer-invariant'",
      "- name: '@deepseek-ai/dsh-peer-local-invariant'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      '  config:',
      "    persona: ''",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-tool-peer'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-invariants', InvariantRegistry],
      ['@deepseek-ai/dsh-agent-wait-local', LocalAgentWaitRegistry],
      ['@deepseek-ai/dsh-agent-wait-interaction', AgentWaitInteraction],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-peer-local', LocalPeerRegistry],
      ['@deepseek-ai/dsh-peer-invariant', PeerInvariant],
      ['@deepseek-ai/dsh-peer-local-invariant', PeerLocalInvariant],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-tool-peer', ToolPeer],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const caller = rootAgent(context, 'loader-peer-caller', '/tmp')
    rootAgent(context, 'loader-peer-target', '/')
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('loader-list-peers'),
      name: 'list_peers',
      arguments: {},
      agent: caller,
    })
    expect(result.isError).toBe(false)
    expect(JSON.parse(resultText(result))).toEqual([{
      session: 'loader-peer-target',
      workspace: '/',
      state: 'idle',
      writeAccess: 'write-capable',
    }])
    expect(context.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining([
      'send_to_peer', 'wait_for_peer', 'list_peers',
    ]))
  })
})
