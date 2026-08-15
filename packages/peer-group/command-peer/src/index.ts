/**
 * Human `/peer` command Consumer for peer-group formation and membership.
 * @module @deepseek-ai/dsh-command-peer
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  PeerGroupError,
  PeerGroupId,
} from '@deepseek-ai/dsh-peer-group'
import type {
  PeerExecutionStatus,
  PeerGroupView,
  PeerMemberView,
} from '@deepseek-ai/dsh-peer-group'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Cordis plugin name. */
export const name = 'command-peer'
/** Services required for human peer-group operations. */
export const inject = ['commands', 'peerGroups']

const GROUP_NAME = /^[a-z][a-z0-9_-]{0,31}$/u
const USAGE = [
  'Usage:',
  '  /peer create <group>',
  '  /peer add <group> <session>',
  '  /peer remove <group> <session>',
  '  /peer list [group]',
  '  /peer dissolve <group>',
].join('\n')

type PeerCommand =
  | { readonly kind: 'create'; readonly group: string }
  | { readonly kind: 'add'; readonly group: string; readonly session: string }
  | { readonly kind: 'remove'; readonly group: string; readonly session: string }
  | { readonly kind: 'list'; readonly group?: string }
  | { readonly kind: 'dissolve'; readonly group: string }
  | { readonly kind: 'invalid' }

/** Fail loudly if a locally closed command union gains an unhandled member. */
/* v8 ignore start -- closed-union backstop is unreachable without violating the TypeScript contract */
function assertNever(value: never): never {
  throw new TypeError(`unknown peer command: ${String(value)}`)
}
/* v8 ignore stop */

/** Parse the exact `/peer` grammar after the registry removes the command name. */
function parsePeerCommand(rawInput: string): PeerCommand {
  const fields = rawInput.trim().split(/\s+/u)
  if (fields.length === 1 && fields[0] === '') return { kind: 'invalid' }
  const [verb, group, session] = fields
  if (verb === 'create' && fields.length === 2 && group !== undefined) return { kind: 'create', group }
  if (verb === 'add' && fields.length === 3 && group !== undefined && session !== undefined) {
    return { kind: 'add', group, session }
  }
  if (verb === 'remove' && fields.length === 3 && group !== undefined && session !== undefined) {
    return { kind: 'remove', group, session }
  }
  if (verb === 'list' && (fields.length === 1 || fields.length === 2)) {
    return { kind: 'list', ...group === undefined ? {} : { group } }
  }
  if (verb === 'dissolve' && fields.length === 2 && group !== undefined) return { kind: 'dissolve', group }
  return { kind: 'invalid' }
}

/** Validate a human-typed group name before invoking the Service. */
function groupId(name: string): PeerGroupId {
  if (!GROUP_NAME.test(name)) {
    throw new PeerGroupError(
      `peer group name '${name}' must match ${String(GROUP_NAME)}`,
      'BAD_GROUP_NAME',
    )
  }
  return PeerGroupId(name)
}

/** Render one execution state with its blocked reason when present. */
function executionLabel(execution: PeerExecutionStatus | undefined): string {
  if (execution === undefined) return 'unavailable'
  return execution.state === 'blocked' ? `blocked (${execution.reason})` : execution.state
}

/** Render a member row with every human-facing list field. */
function renderMember(member: PeerMemberView): string {
  return [
    `  ${member.title ?? '(untitled)'} (${member.sessionId})`,
    `workspace=${member.workspace ?? '(unknown)'}`,
    `availability=${member.availability}`,
    `status=${executionLabel(member.execution)}`,
  ].join(' · ')
}

/** Render current group projections for a human command adapter. */
function renderGroups(groups: readonly PeerGroupView[]): string {
  if (groups.length === 0) return 'No peer groups.'
  return groups.flatMap(group => [
    `Peer group ${group.id}`,
    ...group.members.map(renderMember),
  ]).join('\n')
}

/** Execute one parsed human command through the membership Service. */
async function executePeerCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const command = parsePeerCommand(invocation.rawInput)
  try {
    switch (command.kind) {
      case 'invalid':
        return { kind: 'error', text: USAGE }
      case 'create': {
        const created = await ctx.peerGroups.create(invocation.agent, groupId(command.group))
        return { kind: 'success', text: `Created peer group '${created.id}'.\n${renderGroups([created])}` }
      }
      case 'add': {
        const group = groupId(command.group)
        const member = await ctx.peerGroups.add(invocation.agent, group, SessionId(command.session))
        return { kind: 'success', text: `Added '${member.sessionId}' to peer group '${group}'.` }
      }
      case 'remove': {
        const group = groupId(command.group)
        const session = SessionId(command.session)
        await ctx.peerGroups.remove(invocation.agent, group, session)
        return { kind: 'success', text: `Removed '${session}' from peer group '${group}'.` }
      }
      case 'list':
        return {
          kind: 'success',
          text: renderGroups(ctx.peerGroups.list(
            invocation.agent,
            command.group === undefined ? undefined : groupId(command.group),
          )),
        }
      case 'dissolve': {
        const group = groupId(command.group)
        await ctx.peerGroups.dissolve(invocation.agent, group)
        return { kind: 'success', text: `Dissolved peer group '${group}'.` }
      }
      /* v8 ignore next 2 -- PeerCommand is closed and every member is handled above. */
      default: return assertNever(command)
    }
  } catch (error: unknown) {
    if (error instanceof PeerGroupError) return { kind: 'error', text: `${error.code}: ${error.message}` }
    throw error
  }
}

/**
 * Register the exact `/peer` grammar for composed human-command adapters.
 * @param ctx - context carrying command and peer-group registries.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'peer',
    description: 'Create, inspect, and change peer groups',
    input: { hint: 'create|add|remove|list|dissolve ...' },
    handler: invocation => executePeerCommand(ctx, invocation),
  })
}
