/**
 * Model-facing peer collaboration Consumer over `ctx.peerGroups`.
 * @module @deepseek-ai/dsh-tool-peer
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  PeerGroupError,
  PeerGroupId,
} from '@deepseek-ai/dsh-peer-group'
import type {
  PeerExecutionStatus,
  PeerGroupView,
  PeerMemberView,
  PeerRef,
  PeerWaitObservation,
} from '@deepseek-ai/dsh-peer-group'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'tool-peer'
/** Registries required for model-facing peer operations. */
export const inject = ['tools', 'peerGroups']

const WAIT_STATES = ['working', 'idle', 'blocked'] as const

const PEER_PARAMETER = {
  type: 'object',
  additionalProperties: false,
  description: 'The peer session to address, qualified by group when the same sessions share more than one group.',
  properties: {
    session: { type: 'string', required: true, description: 'Session id shown by list_peers.' },
    group: { type: 'string', description: 'Exact group name; required only when the peer is otherwise ambiguous.' },
  },
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

const PEER_IDENTITY = {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: {
    group: { type: 'string', required: true },
    session: { type: 'string', required: true },
  },
} as const

const EXECUTION_PROPERTIES = {
  state: { type: 'string', required: true, enum: WAIT_STATES },
  blockedReason: { type: 'string', enum: ['interaction', 'peer'] },
} as const

/** Require an exact calling Agent for membership authority. */
function caller(exec: { readonly agent?: Parameters<Context['peerGroups']['list']>[0] }): Parameters<Context['peerGroups']['list']>[0] {
  if (exec.agent === undefined) throw new Error('peer tools require a calling agent')
  return exec.agent
}

/** Convert model arguments to one branded peer address. */
function peerRef(peer: { readonly group?: string; readonly session: string }): PeerRef {
  return {
    session: SessionId(peer.session),
    ...peer.group === undefined ? {} : { group: PeerGroupId(peer.group) },
  }
}

/** Project a matched state without wait-graph or membership implementation ids. */
function observationValue(observation: PeerWaitObservation): {
  peer: { group: string; session: string }
  state: PeerExecutionStatus['state']
  blockedReason?: 'interaction' | 'peer'
} {
  return {
    peer: { group: observation.peer.groupId, session: observation.peer.sessionId },
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

/** Flatten group projections into task-oriented peer rows. */
function peerRows(groups: readonly PeerGroupView[], session?: string): Array<{
  group: string
  session: string
  title?: string
  workspace?: string
  availability: PeerMemberView['availability']
  state?: PeerExecutionStatus['state']
  blockedReason?: 'interaction' | 'peer'
  writeAccess: PeerMemberView['writeAccess']
}> {
  return groups.flatMap(group => group.members
    .filter(member => session === undefined || member.sessionId === session)
    .map(member => ({
      group: group.id,
      session: member.sessionId,
      ...member.title === undefined ? {} : { title: member.title },
      ...member.workspace === undefined ? {} : { workspace: member.workspace },
      availability: member.availability,
      ...member.execution === undefined ? {} : {
        state: member.execution.state,
        ...member.execution.state === 'blocked' ? { blockedReason: member.execution.reason } : {},
      },
      writeAccess: member.writeAccess,
    })))
}

/** Resolve one list request without exposing canonical workspace identity. */
function listRows(
  ctx: Context,
  agent: Parameters<Context['peerGroups']['list']>[0],
  args: { readonly group?: string; readonly peer?: { readonly group?: string; readonly session: string } },
): ReturnType<typeof peerRows> {
  if (args.group !== undefined && args.peer !== undefined) {
    throw new PeerGroupError('list_peers accepts group or peer, not both', 'PEER_AMBIGUOUS')
  }
  if (args.peer === undefined) {
    return peerRows(ctx.peerGroups.list(agent, args.group === undefined ? undefined : PeerGroupId(args.group)))
  }
  const ref = peerRef(args.peer)
  const groups = ctx.peerGroups.list(agent, ref.group)
  const rows = peerRows(groups, ref.session)
  if (rows.length === 0) throw new PeerGroupError(`session '${ref.session}' is not a visible peer`, 'MEMBER_NOT_FOUND')
  if (ref.group === undefined && rows.length > 1) {
    throw new PeerGroupError('peer reference is ambiguous across groups', 'PEER_AMBIGUOUS')
  }
  return rows
}

/** Pure generic pending card derived only from validated arguments. */
function present(title: string, rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind: 'other', ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * Register lateral delivery, state waiting, and membership listing tools.
 * @param ctx - context carrying tool and peer-group registries.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'send_to_peer',
    description: 'Send a message to an existing peer. Without wait, this returns as soon as delivery is accepted. '
      + 'Acceptance is not a reply; a peer reply arrives through a separate delivery. Supply wait only when this '
      + 'call must follow the delivered message through its own turn.',
    parameters: {
      peer: { ...PEER_PARAMETER, required: true },
      message: { type: 'string', required: true, description: 'Work or information to send to the peer.' },
      wait: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional wait tied to this delivered message. Omit it to return immediately after acceptance.',
        properties: WAIT_PROPERTIES,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          deliveryId: { type: 'string', required: true },
          messageId: { type: 'string', required: true },
          peer: PEER_IDENTITY,
          wait: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ...EXECUTION_PROPERTIES,
              turn: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const wait = args.wait === undefined
        ? undefined
        : ctx.peerGroups.resolveWait({
          ...args.wait.until === undefined ? {} : { until: args.wait.until },
          ...args.wait.timeoutMs === undefined ? {} : { timeoutMs: args.wait.timeoutMs },
        })
      const result = await ctx.peerGroups.send({
        caller: caller(exec),
        peer: peerRef(args.peer),
        message: args.message,
        ...wait === undefined ? {} : { wait },
        signal: exec.signal,
      })
      return {
        accepted: true,
        deliveryId: result.delivery.deliveryId,
        messageId: result.delivery.messageId,
        peer: {
          group: result.delivery.peer.groupId,
          session: result.delivery.peer.sessionId,
        },
        ...result.settled === undefined ? {} : {
          wait: { ...executionValue(result.settled.execution), turn: result.settled.turn },
        },
      }
    },
    presentCall: args => present(`Send to peer ${args.peer.session}`, args.message),
  }))

  ctx.tools.register(defineTool({
    name: 'wait_for_peer',
    description: 'Wait until an existing peer reaches one of the requested states. This observes peer state and is '
      + 'not correlated to any message. The initial state may satisfy the request immediately.',
    parameters: { peer: { ...PEER_PARAMETER, required: true }, ...WAIT_PROPERTIES },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { peer: PEER_IDENTITY, ...EXECUTION_PROPERTIES },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const wait = ctx.peerGroups.resolveWait({
        ...args.until === undefined ? {} : { until: args.until },
        ...args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs },
      })
      const observed = await ctx.peerGroups.wait({
        caller: caller(exec),
        peer: peerRef(args.peer),
        wait,
        signal: exec.signal,
      })
      return observationValue(observed)
    },
    presentCall: args => present(`Wait for peer ${args.peer.session}`),
  }))

  ctx.tools.register(defineTool({
    name: 'list_peers',
    description: 'List peer sessions visible through current group membership, or select one peer session.',
    parameters: {
      group: { type: 'string', description: 'Exact group name to list.' },
      peer: PEER_PARAMETER,
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            group: { type: 'string', required: true },
            session: { type: 'string', required: true },
            title: { type: 'string' },
            workspace: { type: 'string' },
            availability: { type: 'string', required: true, enum: ['live', 'inactive'] },
            state: { type: 'string', enum: WAIT_STATES },
            blockedReason: { type: 'string', enum: ['interaction', 'peer'] },
            writeAccess: { type: 'string', required: true, enum: ['write-capable', 'read-only'] },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      return Promise.resolve(listRows(ctx, caller(exec), args))
    },
    presentCall: args => present(
      args.peer === undefined ? `List peers${args.group === undefined ? '' : ` in ${args.group}`}` : `Read peer ${args.peer.session}`,
    ),
  }))
}
