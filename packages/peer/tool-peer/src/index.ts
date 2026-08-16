/**
 * Model-facing peer collaboration Consumer over `ctx.peers`.
 * @module @deepseek-ai/dsh-tool-peer
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  PeerExecutionStatus,
  PeerWaitObservation,
} from '@deepseek-ai/dsh-peer'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'tool-peer'
/** Registries required for model-facing peer operations. */
export const inject = ['tools', 'peers']

const WAIT_STATES = ['working', 'idle', 'blocked'] as const

const PEER_PARAMETER = {
  type: 'string',
  description: 'Exact active-root session id or unique user-set session title. Use list_peers to discover peers.',
} as const

const WAIT_PROPERTIES = {
  until: {
    type: 'array',
    items: { type: 'string', enum: WAIT_STATES },
    description: 'States that may complete the wait. Defaults to idle or blocked.',
  },
  timeoutMs: {
    type: 'integer',
    description: 'Maximum wait in milliseconds. The deployment supplies the default and maximum.',
  },
} as const

const EXECUTION_PROPERTIES = {
  state: { type: 'string', required: true, enum: WAIT_STATES },
  blockedReason: { type: 'string', enum: ['interaction', 'peer'] },
} as const

/** Require an exact calling Agent for root-peer authority. */
function caller(exec: { readonly agent?: Parameters<Context['peers']['list']>[0] }): Parameters<Context['peers']['list']>[0] {
  if (exec.agent === undefined) throw new Error('peer tools require a calling agent')
  return exec.agent
}

/** Project a matched state without exposing the wait-graph id. */
function observationValue(observation: PeerWaitObservation): {
  peer: string
  state: PeerExecutionStatus['state']
  blockedReason?: 'interaction' | 'peer'
} {
  return {
    peer: observation.peerSessionId,
    state: observation.execution.state,
    ...observation.execution.state === 'blocked'
      ? { blockedReason: observation.execution.reason }
      : {},
  }
}

/** Project only the matched execution fields for a delivery-correlated result. */
function executionValue(execution: PeerExecutionStatus): {
  state: PeerExecutionStatus['state']
  blockedReason?: 'interaction' | 'peer'
} {
  return {
    state: execution.state,
    ...execution.state === 'blocked' ? { blockedReason: execution.reason } : {},
  }
}

/** Pure generic pending card derived only from validated arguments. */
function present(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Register active-root discovery, lateral delivery, and state-waiting tools.
 * @param ctx - context carrying tool and peer registries.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'send_to_peer',
    description: 'Send a line to an active root peer. Without wait, this returns as soon as delivery is accepted. '
      + 'Acceptance is not a reply; a peer reply arrives through a separate delivery. Supply wait only when this '
      + 'call must follow the delivered message through its own turn. A line starting with a slash that the peer '
      + 'recognizes runs there as that command instead, exactly as if a person typed it into that session; the '
      + 'result then reports ranAsCommand and no message is delivered.',
    parameters: {
      peer: { ...PEER_PARAMETER, required: true },
      message: {
        type: 'string',
        required: true,
        description: 'Work or information to send, or a slash command line to run in the peer session.',
      },
      wait: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional wait. Message delivery follows its claimed turn; command execution observes state only.',
        properties: WAIT_PROPERTIES,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          deliveryId: { type: 'string', description: 'Absent when the line ran as a command.' },
          messageId: { type: 'string', description: 'Absent when the line ran as a command.' },
          peer: { type: 'string', required: true },
          ranAsCommand: {
            type: 'string',
            description: 'Command name the peer ran instead of receiving a message. No message was delivered.',
          },
          commandOk: { type: 'boolean', description: 'Whether that command settled successfully.' },
          commandText: { type: 'string', description: 'Text the command handler returned, when it returned any.' },
          sharesWritableWorkspace: {
            type: 'boolean',
            description:
              'Present and true when you and this peer can both write one shared working directory, '
              + 'so edits made at the same time would collide. The message was still delivered.',
          },
          wait: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ...EXECUTION_PROPERTIES,
              turn: { type: 'integer', description: 'Absent when the line ran as a command, which claims no turn.' },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const wait = args.wait === undefined
        ? undefined
        : ctx.peers.resolveWait({
          ...args.wait.until === undefined ? {} : { until: args.wait.until },
          ...args.wait.timeoutMs === undefined ? {} : { timeoutMs: args.wait.timeoutMs },
        })
      const result = await ctx.peers.send({
        caller: caller(exec),
        peer: args.peer,
        message: args.message,
        ...wait === undefined ? {} : { wait },
        signal: exec.signal,
      })
      if (result.kind === 'command') {
        return {
          accepted: true,
          ranAsCommand: result.command.name,
          commandOk: result.command.ok,
          peer: result.command.peerSessionId,
          ...result.command.text === undefined ? {} : { commandText: result.command.text },
          ...result.settled === undefined ? {} : { wait: executionValue(result.settled.execution) },
        }
      }
      return {
        accepted: true,
        deliveryId: result.delivery.deliveryId,
        messageId: result.delivery.messageId,
        peer: result.delivery.peerSessionId,
        ...result.delivery.sharesWritableWorkspace === undefined ? {} : { sharesWritableWorkspace: true },
        ...result.settled === undefined ? {} : {
          wait: { ...executionValue(result.settled.execution), turn: result.settled.turn },
        },
      }
    },
    presentCall: args => present(`Send to peer ${args.peer}`, args.message),
  }))

  ctx.tools.register(defineTool({
    name: 'wait_for_peer',
    description: 'Wait until an active root peer reaches one of the requested states. This observes peer state and is '
      + 'not correlated to any message. The initial state may satisfy the request immediately.',
    parameters: { peer: { ...PEER_PARAMETER, required: true }, ...WAIT_PROPERTIES },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { peer: { type: 'string', required: true }, ...EXECUTION_PROPERTIES },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const wait = ctx.peers.resolveWait({
        ...args.until === undefined ? {} : { until: args.until },
        ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
      })
      const observed = await ctx.peers.wait({
        caller: caller(exec),
        peer: args.peer,
        wait,
        signal: exec.signal,
      })
      return observationValue(observed)
    },
    presentCall: args => present(`Wait for peer ${args.peer}`),
  }))

  ctx.tools.register(defineTool({
    name: 'list_peers',
    description: 'List every other active root session. Only titles marked user are valid peer addresses.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            session: { type: 'string', required: true },
            title: { type: 'string' },
            titleSource: { type: 'string', enum: ['user', 'automatic'] },
            workspace: { type: 'string' },
            preset: { type: 'string' },
            state: { type: 'string', required: true, enum: WAIT_STATES },
            blockedReason: { type: 'string', enum: ['interaction', 'peer'] },
            writeAccess: { type: 'string', required: true, enum: ['write-capable', 'read-only'] },
            sharesWritableWorkspace: {
              type: 'boolean',
              description:
                'Present and true when this peer and you can both write one shared working directory, '
                + 'so edits made at the same time would collide. Delivery is still allowed.',
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(_args, exec) {
      return Promise.resolve(ctx.peers.list(caller(exec)).map(peer => ({
        session: peer.sessionId,
        ...peer.title === undefined ? {} : { title: peer.title, titleSource: peer.titleSource },
        ...peer.workspace === undefined ? {} : { workspace: peer.workspace },
        ...peer.preset === undefined ? {} : { preset: peer.preset },
        state: peer.execution.state,
        ...peer.execution.state === 'blocked' ? { blockedReason: peer.execution.reason } : {},
        writeAccess: peer.writeAccess,
        ...peer.sharesWritableWorkspace === undefined ? {} : { sharesWritableWorkspace: true },
      })))
    },
    presentCall: () => present('List peers'),
  }))
}
