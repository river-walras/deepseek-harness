/**
 * Process-local Service Provider for `ctx.peerGroups`.
 * @module @deepseek-ai/dsh-peer-group-local
 */

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AgentWaitCursor,
  AgentWaitLease,
  AgentWaitLeaseView,
  AgentWaitSnapshot,
  AgentWaitTransition,
} from '@deepseek-ai/dsh-agent-wait'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import {
  PeerDeliveryId,
  PeerGroupError,
  PeerGroupId,
  PeerGroupRegistry,
  PeerMembershipIncarnation,
  PeerWaitId,
} from '@deepseek-ai/dsh-peer-group'
import type {
  PeerDeliveryAcceptance,
  PeerExecutionStatus,
  PeerGroupErrorCode,
  PeerGroupView,
  PeerMemberView,
  PeerMembership,
  PeerMembershipIncarnation as PeerMembershipIncarnationType,
  PeerRef,
  PeerSendRequest,
  PeerSendResult,
  PeerWaitObservation,
  PeerWaitOptions,
  PeerWaitRequest,
  PeerWaitSpec,
  PeerWaitState,
  PeerWriteAccess,
} from '@deepseek-ai/dsh-peer-group'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'

const GROUP_NAME = /^[a-z][a-z0-9_-]{0,31}$/u
const EFFECT_GATE_MS = 5_000
const DEFAULT_WAIT_STATES: readonly [PeerWaitState, PeerWaitState] = ['idle', 'blocked']

/** Required deployment timeout bounds. */
export interface Config {
  /** Timeout used when a Consumer omits one. */
  readonly defaultWaitTimeoutMs: number
  /** Largest timeout a Consumer may request. */
  readonly maxWaitTimeoutMs: number
}

type CanonicalWorkspaceIdentity = string

/** Provider-owned membership state. */
interface MemberRecord extends PeerMembership {
  readonly workspaceIdentity: CanonicalWorkspaceIdentity
  readonly workspaceLabel: string | undefined
  writeAccess: PeerWriteAccess
}

/** Provider-owned group state. */
interface GroupRecord {
  readonly id: PeerGroupId
  readonly members: Map<SessionId, MemberRecord>
}

/** One atomically installed wait-for edge. */
interface WaitEdge {
  readonly id: ReturnType<typeof PeerWaitId>
  readonly groupId: PeerGroupId
  readonly waiterSessionId: SessionId
  readonly targetSessionId: SessionId
}

/** Mutable settlement state for one bounded wait. */
interface ActiveWait {
  readonly edge: WaitEdge
  readonly waiterIncarnation: PeerMembershipIncarnationType
  readonly targetIncarnation: PeerMembershipIncarnationType
  readonly until: ReadonlySet<PeerWaitState>
  readonly targetAgent: Agent
  readonly mode: 'standalone' | 'delivery'
  readonly messageId: MessageId | undefined
  readonly initialExecution: string
  readonly resolve: (value: PeerWaitObservation & { readonly turn?: number }) => void
  readonly reject: (error: PeerGroupError) => void
  timeoutTimer: ReturnType<typeof setTimeout> | undefined
  effectTimer: ReturnType<typeof setTimeout> | undefined
  abort: (() => void) | undefined
  claimedTurn: number | undefined
  turnEnded: boolean
  effectObserved: boolean
  active: boolean
}

/** In-memory peer-group registry for one Cordis provider generation. */
export class LocalPeerGroupRegistry extends PeerGroupRegistry {
  static inject = ['agents', 'agentWaits', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    defaultWaitTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
    maxWaitTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
  })

  private readonly groups = new Map<PeerGroupId, GroupRecord>()
  private readonly waitLeases = new Map<AgentWaitLeaseView['id'], AgentWaitLeaseView>()
  private readonly edges = new Map<ReturnType<typeof PeerWaitId>, WaitEdge>()
  private readonly waits = new Map<ReturnType<typeof PeerWaitId>, ActiveWait>()
  private waitCursor: AgentWaitCursor
  private disposed = false

  /**
   * Create one process-local provider.
   * @param ctx - Cordis context carrying Agents and wait observation.
   * @param config - validated default and maximum wait bounds.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    if (config.defaultWaitTimeoutMs > config.maxWaitTimeoutMs) {
      throw new Error('peer-group-local defaultWaitTimeoutMs must not exceed maxWaitTimeoutMs')
    }
    const snapshot = ctx.agentWaits.snapshot()
    this.waitCursor = snapshot.cursor
    this.replaceWaitSnapshot(snapshot)
    const stopWaitObservation = ctx.agentWaits.onChanged(() => { this.drainWaitChanges() })
    this.drainWaitChanges()

    ctx.effect(() => () => { stopWaitObservation() }, 'peerGroups.stopWaitObservation()')
    ctx.effect(() => () => { this.disposeState() }, 'peerGroups.disposeState()')
    ctx.on('agent/status', ({ agent }) => { this.notifyWaitsFor(agent.id) })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const wait of [...this.waits.values()]) {
        if (wait.edge.waiterSessionId === agent.id) {
          this.failWait(wait, 'WAIT_ABORTED', 'waiting agent was disposed')
        } else if (wait.edge.targetSessionId === agent.id) {
          this.failWait(wait, 'PEER_UNAVAILABLE', 'peer became inactive')
        }
      }
    })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      for (const wait of this.waits.values()) {
        if (wait.mode !== 'delivery' || wait.targetAgent !== agent || wait.messageId !== message.id) continue
        wait.claimedTurn = turn
        wait.effectObserved = true
        this.clearEffectTimer(wait)
        this.evaluateWait(wait)
      }
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'sandbox/mode' || event.type === 'approval/policy') {
        this.observePolicyChange(session)
      }
      if (event.type !== 'turn/end') return
      for (const wait of this.waits.values()) {
        if (wait.targetAgent.session !== session || wait.claimedTurn !== event.data.turn) continue
        wait.turnEnded = true
        this.evaluateWait(wait)
      }
    })
  }

  resolveWait(options: PeerWaitOptions = {}): PeerWaitSpec {
    this.assertActive()
    const until = options.until ?? DEFAULT_WAIT_STATES
    if (until.length === 0) {
      throw new PeerGroupError('peer wait requires at least one state', 'WAIT_TIMEOUT')
    }
    const timeoutMs = options.timeoutMs ?? this.config.defaultWaitTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.config.maxWaitTimeoutMs) {
      throw new PeerGroupError(
        `peer wait timeoutMs must be a positive integer no greater than ${this.config.maxWaitTimeoutMs}`,
        'WAIT_TIMEOUT',
      )
    }
    return { until: [...new Set(until)] as [PeerWaitState, ...PeerWaitState[]], timeoutMs }
  }

  /* oxlint-disable typescript/require-await -- the async Service API normalizes synchronous admission failures to rejections */
  async create(caller: Agent, name: string): Promise<PeerGroupView> {
    this.assertRoot(caller, 'CALLER')
    const groupId = this.validateGroupId(name)
    if (this.groups.has(groupId)) throw new PeerGroupError(`peer group '${name}' already exists`, 'GROUP_EXISTS')
    const member = this.admit(caller, groupId)
    const group: GroupRecord = { id: groupId, members: new Map([[caller.id, member]]) }
    this.groups.set(groupId, group)
    return this.projectGroup(group)
  }

  async add(caller: Agent, groupId: PeerGroupId, sessionId: SessionId): Promise<PeerMemberView> {
    const group = this.mutableGroup(caller, groupId)
    if (group.members.has(sessionId)) {
      throw new PeerGroupError(`session '${sessionId}' is already a member of '${groupId}'`, 'MEMBER_EXISTS')
    }
    const target = this.requireRoot(sessionId, 'MEMBER')
    const member = this.admit(target, group.id)
    this.assertSingleWriter(group, member)
    group.members.set(sessionId, member)
    return this.projectMember(member)
  }

  async remove(caller: Agent, groupId: PeerGroupId, sessionId: SessionId): Promise<void> {
    const group = this.mutableGroup(caller, groupId)
    const member = group.members.get(sessionId)
    if (member === undefined) {
      throw new PeerGroupError(`session '${sessionId}' is not a member of '${groupId}'`, 'MEMBER_NOT_FOUND')
    }
    this.removeMembership(group, member, 'MEMBERSHIP_REPLACED')
  }

  async dissolve(caller: Agent, groupId: PeerGroupId): Promise<void> {
    const group = this.mutableGroup(caller, groupId)
    for (const wait of [...this.waits.values()]) {
      if (wait.edge.groupId === group.id) {
        this.failWait(wait, 'GROUP_DISSOLVED', `peer group '${group.id}' was dissolved`)
      }
    }
    this.groups.delete(group.id)
  }
  /* oxlint-enable typescript/require-await */

  list(caller: Agent, groupId?: PeerGroupId): readonly PeerGroupView[] {
    this.assertRoot(caller, 'CALLER')
    if (groupId !== undefined) {
      const group = this.requireGroup(groupId)
      this.requireMembership(group, caller.id, 'CALLER_NOT_MEMBER')
      return [this.projectGroup(group)]
    }
    return [...this.groups.values()]
      .filter(group => group.members.has(caller.id))
      .map(group => this.projectGroup(group))
  }

  async send(request: PeerSendRequest): Promise<PeerSendResult> {
    this.assertActive()
    const resolved = this.resolvePeer(request.caller, request.peer)
    const target = this.liveTarget(resolved.member)
    if (this.blockedReason(target.id) === 'interaction') {
      throw new PeerGroupError(`peer '${target.id}' is blocked on interaction`, 'PEER_BLOCKED_INTERACTION')
    }
    if (request.signal?.aborted === true) {
      throw new PeerGroupError('peer delivery was aborted before acceptance', 'WAIT_ABORTED')
    }
    const sender = this.requireMembership(resolved.group, request.caller.id, 'CALLER_NOT_MEMBER')
    const deliveryId = PeerDeliveryId(randomUUID())
    const message = createUserMessage({
      content: [{ type: 'text', text: request.message }],
      source: {
        kind: 'peer',
        form: 'relay',
        groupId: resolved.group.id,
        senderSessionId: sender.sessionId,
        senderIncarnation: sender.incarnation,
        deliveryId,
      },
    })
    const delivery: PeerDeliveryAcceptance = {
      deliveryId,
      messageId: message.id,
      peer: this.membership(resolved.member),
    }
    if (request.wait === undefined) {
      this.authorizePinned(request.caller, resolved.group.id, sender.incarnation, resolved.member)
      target.followup(message)
      return { delivery }
    }

    const initial = this.execution(target)
    const settled = await this.runWait({
      caller: request.caller,
      group: resolved.group,
      targetMember: resolved.member,
      target,
      spec: this.validateSpec(request.wait),
      signal: request.signal,
      mode: 'delivery',
      messageId: message.id,
      initial,
      start: () => {
        this.authorizePinned(request.caller, resolved.group.id, sender.incarnation, resolved.member)
        target.followup(message)
      },
    })
    if (settled.turn === undefined) throw new PeerGroupError('delivered message was not claimed', 'SUBSCRIPTION_FAILED')
    return { delivery, settled: { ...settled, turn: settled.turn } }
  }

  async wait(request: PeerWaitRequest): Promise<PeerWaitObservation> {
    this.assertActive()
    const resolved = this.resolvePeer(request.caller, request.peer)
    const target = this.liveTarget(resolved.member)
    return this.runWait({
      caller: request.caller,
      group: resolved.group,
      targetMember: resolved.member,
      target,
      spec: this.validateSpec(request.wait),
      signal: request.signal,
      mode: 'standalone',
      messageId: undefined,
      initial: this.execution(target),
      start: () => {},
    })
  }

  /** Run one graph-owned bounded wait and always remove its edge and lease. */
  private async runWait(input: {
    readonly caller: Agent
    readonly group: GroupRecord
    readonly targetMember: MemberRecord
    readonly target: Agent
    readonly spec: PeerWaitSpec
    readonly signal: AbortSignal | undefined
    readonly mode: ActiveWait['mode']
    readonly messageId: MessageId | undefined
    readonly initial: PeerExecutionStatus
    readonly start: () => void
  }): Promise<PeerWaitObservation & { readonly turn?: number }> {
    this.assertRoot(input.caller, 'CALLER')
    if (input.signal?.aborted === true) throw new PeerGroupError('peer wait was aborted', 'WAIT_ABORTED')
    const waiter = this.requireMembership(input.group, input.caller.id, 'CALLER_NOT_MEMBER')
    const edge: WaitEdge = {
      id: PeerWaitId(randomUUID()),
      groupId: input.group.id,
      waiterSessionId: input.caller.id,
      targetSessionId: input.targetMember.sessionId,
    }
    this.installEdge(edge)
    let lease: AgentWaitLease | undefined
    let record: ActiveWait | undefined
    try {
      lease = this.ctx.agentWaits.acquire({ lifetime: { kind: 'agent', agent: input.caller }, reason: 'peer' })
      const pending = Promise.withResolvers<PeerWaitObservation & { readonly turn?: number }>()
      record = {
        edge,
        waiterIncarnation: waiter.incarnation,
        targetIncarnation: input.targetMember.incarnation,
        until: new Set(input.spec.until),
        targetAgent: input.target,
        mode: input.mode,
        messageId: input.messageId,
        initialExecution: this.executionKey(input.initial),
        resolve: pending.resolve,
        reject: pending.reject,
        timeoutTimer: undefined,
        effectTimer: undefined,
        abort: undefined,
        claimedTurn: undefined,
        turnEnded: false,
        effectObserved: input.mode === 'standalone' || input.initial.state === 'working',
        active: true,
      }
      this.waits.set(edge.id, record)
      this.armWait(record, input.spec.timeoutMs, input.signal)
      input.start()
      this.evaluateWait(record)
      return await pending.promise
    } finally {
      if (record !== undefined) this.disposeWaitRecord(record)
      this.edges.delete(edge.id)
      lease?.release()
    }
  }

  /** Start timeout, effect-gate, and cancellation settlement. */
  private armWait(wait: ActiveWait, timeoutMs: number, signal: AbortSignal | undefined): void {
    if (!wait.effectObserved) {
      const gateMs = Math.min(timeoutMs, EFFECT_GATE_MS)
      wait.effectTimer = setTimeout(() => {
        const code = timeoutMs < EFFECT_GATE_MS ? 'WAIT_TIMEOUT' : 'PROMPT_STALLED'
        this.failWait(wait, code, code === 'PROMPT_STALLED'
          ? 'peer delivery produced no observed transition'
          : `peer wait exceeded ${timeoutMs} ms`)
      }, gateMs)
      wait.effectTimer.unref()
    }
    wait.timeoutTimer = setTimeout(() => {
      this.failWait(wait, 'WAIT_TIMEOUT', `peer wait exceeded ${timeoutMs} ms`)
    }, timeoutMs)
    wait.timeoutTimer.unref()
    if (signal !== undefined) {
      const abort = (): void => { this.failWait(wait, 'WAIT_ABORTED', 'peer wait was aborted') }
      signal.addEventListener('abort', abort, { once: true })
      wait.abort = () => { signal.removeEventListener('abort', abort) }
    }
  }

  /** Evaluate membership pinning and the requested state. */
  private evaluateWait(wait: ActiveWait): void {
    if (!wait.active) return
    const group = this.groups.get(wait.edge.groupId)
    if (group === undefined) {
      this.failWait(wait, 'GROUP_DISSOLVED', `peer group '${wait.edge.groupId}' was dissolved`)
      return
    }
    const waiter = group.members.get(wait.edge.waiterSessionId)
    const target = group.members.get(wait.edge.targetSessionId)
    if (waiter?.incarnation !== wait.waiterIncarnation || target?.incarnation !== wait.targetIncarnation) {
      this.failWait(wait, 'MEMBERSHIP_REPLACED', 'peer membership incarnation changed')
      return
    }
    let agent: Agent
    try {
      agent = this.liveTarget(target)
    } catch (error: unknown) {
      this.rejectFrom(wait, error)
      return
    }
    const execution = this.execution(agent)
    if (!wait.effectObserved && this.executionKey(execution) !== wait.initialExecution) {
      wait.effectObserved = true
      this.clearEffectTimer(wait)
    }
    if (wait.mode === 'delivery') {
      if (wait.claimedTurn === undefined) return
      if (execution.state !== 'working' && !wait.turnEnded) return
    }
    if (!wait.until.has(execution.state)) return
    wait.active = false
    wait.resolve({
      waitId: wait.edge.id,
      peer: this.membership(target),
      execution,
      ...wait.claimedTurn === undefined ? {} : { turn: wait.claimedTurn },
    })
  }

  /** Settle one active wait with a stable error. */
  private failWait(wait: ActiveWait, code: PeerGroupErrorCode, message: string): void {
    if (!wait.active) return
    wait.active = false
    wait.reject(new PeerGroupError(message, code))
  }

  /** Preserve typed peer failures and classify observation failures. */
  private rejectFrom(wait: ActiveWait, error: unknown): void {
    if (error instanceof PeerGroupError) {
      this.failWait(wait, error.code, error.message)
      return
    }
    this.failWait(wait, 'SUBSCRIPTION_FAILED', `peer wait observation failed: ${String(error)}`)
  }

  /** Release all per-wait listeners and timers after first settlement. */
  private disposeWaitRecord(wait: ActiveWait): void {
    wait.active = false
    this.waits.delete(wait.edge.id)
    if (wait.timeoutTimer !== undefined) clearTimeout(wait.timeoutTimer)
    this.clearEffectTimer(wait)
    wait.abort?.()
    wait.abort = undefined
  }

  /** Clear the delivery-effect timer after an observed transition. */
  private clearEffectTimer(wait: ActiveWait): void {
    if (wait.effectTimer !== undefined) clearTimeout(wait.effectTimer)
    wait.effectTimer = undefined
  }

  /** Check for a group-qualified path before publishing the new edge. */
  private installEdge(edge: WaitEdge): void {
    const pending = [edge.targetSessionId]
    const visited = new Set<SessionId>()
    while (pending.length > 0) {
      const sessionId = pending.pop()
      /* v8 ignore next -- the loop condition proves one entry exists. */
      if (sessionId === undefined) break
      if (sessionId === edge.waiterSessionId) {
        throw new PeerGroupError('peer wait would create a cycle', 'WAIT_CYCLE')
      }
      if (visited.has(sessionId)) continue
      visited.add(sessionId)
      for (const current of this.edges.values()) {
        if (current.groupId === edge.groupId && current.waiterSessionId === sessionId) {
          pending.push(current.targetSessionId)
        }
      }
    }
    this.edges.set(edge.id, edge)
  }

  /** Observe policy state after the authoritative session event commits. */
  private observePolicyChange(session: Session): void {
    for (const group of this.groups.values()) {
      const member = group.members.get(session.id)
      if (member === undefined) continue
      member.writeAccess = this.writeAccess(session)
      if (member.writeAccess !== 'write-capable' || !this.hasOtherWriter(group, member)) continue
      this.removeMembership(group, member, 'MEMBERSHIP_REPLACED')
      queueMicrotask(() => {
        try {
          session.append('peer-group/membership-removed', {
            groupId: group.id,
            incarnation: member.incarnation,
            reason: 'second-writer',
          })
        } catch (error: unknown) {
          this.ctx.logger.warn(`peer-group policy-removal event failed: ${String(error)}`)
        }
      })
    }
  }

  /** Remove one incarnation and terminate waits that depend on it. */
  private removeMembership(
    group: GroupRecord,
    member: MemberRecord,
    code: Extract<PeerGroupErrorCode, 'MEMBERSHIP_REPLACED'>,
  ): void {
    group.members.delete(member.sessionId)
    for (const wait of [...this.waits.values()]) {
      if (wait.edge.groupId !== group.id) continue
      if (wait.edge.waiterSessionId === member.sessionId || wait.edge.targetSessionId === member.sessionId) {
        this.failWait(wait, code, `membership '${member.sessionId}' was removed from '${group.id}'`)
      }
    }
  }

  /** Validate and mint one fresh root membership. */
  private admit(agent: Agent, groupId: PeerGroupId): MemberRecord {
    this.assertRoot(agent, 'MEMBER')
    const workspaceRoot = this.ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
    return {
      groupId,
      sessionId: agent.id,
      incarnation: PeerMembershipIncarnation(randomUUID()),
      workspaceIdentity: this.canonicalWorkspace(agent),
      workspaceLabel: basename(workspaceRoot) || workspaceRoot,
      writeAccess: this.writeAccess(agent.session),
    }
  }

  /** Reject a second write-capable member in the same canonical workspace. */
  private assertSingleWriter(group: GroupRecord, candidate: MemberRecord): void {
    if (candidate.writeAccess === 'write-capable' && this.hasOtherWriter(group, candidate)) {
      throw new PeerGroupError('peer group cannot admit a second writer in one workspace', 'SECOND_WRITER')
    }
  }

  /** Whether another member is a writer in the candidate's workspace. */
  private hasOtherWriter(group: GroupRecord, candidate: MemberRecord): boolean {
    return [...group.members.values()].some(member => member.sessionId !== candidate.sessionId
      && member.workspaceIdentity === candidate.workspaceIdentity
      && member.writeAccess === 'write-capable')
  }

  /** Resolve a provider-private stable canonical workspace identity. */
  private canonicalWorkspace(agent: Agent): CanonicalWorkspaceIdentity {
    const workspaceRoot = this.ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
    try {
      return realpathSync.native(workspaceRoot)
    } catch {
      throw new Error(`cannot resolve canonical workspace for session '${agent.id}'`)
    }
  }

  /** Classify one session from its current paired policy events. */
  private writeAccess(session: Session): PeerWriteAccess {
    return effectiveSandboxMode(session.events) === 'read-only'
      && effectiveApprovalPolicy(session.events) === 'never'
      ? 'read-only'
      : 'write-capable'
  }

  /** Resolve an explicit or unambiguous peer grant. */
  private resolvePeer(caller: Agent, peer: PeerRef): { group: GroupRecord; member: MemberRecord } {
    this.assertRoot(caller, 'CALLER')
    if (peer.group !== undefined) {
      const group = this.requireGroup(peer.group)
      this.requireMembership(group, caller.id, 'CALLER_NOT_MEMBER')
      return { group, member: this.requireMembership(group, peer.session, 'MEMBER_NOT_FOUND') }
    }
    const matches = [...this.groups.values()].filter(group =>
      group.members.has(caller.id) && group.members.has(peer.session))
    if (matches.length === 0) throw new PeerGroupError('caller and peer share no group', 'MEMBER_NOT_FOUND')
    if (matches.length > 1) throw new PeerGroupError('peer reference is ambiguous across groups', 'PEER_AMBIGUOUS')
    const group = matches[0]
    /* v8 ignore next -- the filter above proves the target membership exists. */
    if (group === undefined) throw new PeerGroupError('peer group resolution failed', 'GROUP_NOT_FOUND')
    return { group, member: this.requireMembership(group, peer.session, 'MEMBER_NOT_FOUND') }
  }

  /** Re-authorize both pinned incarnations immediately before enqueue. */
  private authorizePinned(
    caller: Agent,
    groupId: PeerGroupId,
    senderIncarnation: PeerMembershipIncarnationType,
    target: MemberRecord,
  ): void {
    this.assertRoot(caller, 'CALLER')
    const group = this.requireGroup(groupId)
    const sender = this.requireMembership(group, caller.id, 'CALLER_NOT_MEMBER')
    const currentTarget = this.requireMembership(group, target.sessionId, 'MEMBER_NOT_FOUND')
    if (sender.incarnation !== senderIncarnation || currentTarget.incarnation !== target.incarnation) {
      throw new PeerGroupError('peer membership incarnation changed before delivery', 'MEMBERSHIP_REPLACED')
    }
    const live = this.liveTarget(currentTarget)
    if (this.blockedReason(live.id) === 'interaction') {
      throw new PeerGroupError(`peer '${live.id}' is blocked on interaction`, 'PEER_BLOCKED_INTERACTION')
    }
  }

  /** Return an exact live root for a current membership. */
  private liveTarget(member: MemberRecord): Agent {
    const agent = this.ctx.agents.get(member.sessionId)
    if (agent === undefined || !this.ctx.agents.roots().includes(agent)) {
      throw new PeerGroupError(`peer '${member.sessionId}' is inactive`, 'PEER_UNAVAILABLE')
    }
    return agent
  }

  /** Current execution state with interaction precedence over peer. */
  private execution(agent: Agent): PeerExecutionStatus {
    const reason = this.blockedReason(agent.id)
    if (reason !== undefined) return { state: 'blocked', reason }
    return agent.status === 'running' ? { state: 'working' } : { state: 'idle' }
  }

  /** Highest-priority active wait reason for one session. */
  private blockedReason(sessionId: SessionId): 'interaction' | 'peer' | undefined {
    let peer = false
    for (const lease of this.waitLeases.values()) {
      if (lease.sessionId !== sessionId) continue
      if (lease.reason === 'interaction') return 'interaction'
      peer = true
    }
    return peer ? 'peer' : undefined
  }

  /** Apply retained wait transitions and notify state observers. */
  private drainWaitChanges(): void {
    if (this.disposed) return
    try {
      const read = this.ctx.agentWaits.changes(this.waitCursor)
      if (read.kind === 'refresh') {
        this.replaceWaitSnapshot(read.snapshot)
      } else {
        for (const transition of read.transitions) this.applyWaitTransition(transition)
        this.waitCursor = read.cursor
      }
      this.notifyAllWaits()
    } catch (error: unknown) {
      for (const wait of [...this.waits.values()]) {
        this.failWait(wait, 'SUBSCRIPTION_FAILED', `agent-wait subscription failed: ${String(error)}`)
      }
    }
  }

  /** Replace the wait projection after initial read or explicit refresh. */
  private replaceWaitSnapshot(snapshot: AgentWaitSnapshot): void {
    this.waitLeases.clear()
    for (const lease of snapshot.leases) this.waitLeases.set(lease.id, lease)
    this.waitCursor = snapshot.cursor
  }

  /** Apply one retained wait transition to the local projection. */
  private applyWaitTransition(transition: AgentWaitTransition): void {
    if (transition.kind === 'acquired') this.waitLeases.set(transition.lease.id, transition.lease)
    else this.waitLeases.delete(transition.lease.id)
  }

  /** Evaluate every active wait after a projection change. */
  private notifyAllWaits(): void {
    for (const wait of [...this.waits.values()]) this.evaluateWait(wait)
  }

  /** Evaluate waits involving one Agent status transition. */
  private notifyWaitsFor(sessionId: SessionId): void {
    for (const wait of [...this.waits.values()]) {
      if (wait.edge.targetSessionId === sessionId) this.evaluateWait(wait)
    }
  }

  /** Validate one caller-supplied resolved wait against provider configuration. */
  private validateSpec(spec: PeerWaitSpec): PeerWaitSpec {
    return this.resolveWait({ until: spec.until, timeoutMs: spec.timeoutMs })
  }

  /** Return the group after validating both id and caller membership. */
  private mutableGroup(caller: Agent, groupId: PeerGroupId): GroupRecord {
    this.assertRoot(caller, 'CALLER')
    const group = this.requireGroup(groupId)
    this.requireMembership(group, caller.id, 'CALLER_NOT_MEMBER')
    return group
  }

  /** Resolve a group by exact validated id. */
  private requireGroup(groupId: PeerGroupId): GroupRecord {
    const validated = this.validateGroupId(groupId)
    const group = this.groups.get(validated)
    if (group === undefined) throw new PeerGroupError(`peer group '${groupId}' does not exist`, 'GROUP_NOT_FOUND')
    return group
  }

  /** Resolve one current group-qualified membership. */
  private requireMembership(
    group: GroupRecord,
    sessionId: SessionId,
    code: Extract<PeerGroupErrorCode, 'CALLER_NOT_MEMBER' | 'MEMBER_NOT_FOUND'>,
  ): MemberRecord {
    const member = group.members.get(sessionId)
    if (member === undefined) throw new PeerGroupError(`session '${sessionId}' is not a member of '${group.id}'`, code)
    return member
  }

  /** Validate a human-typed group name without normalization. */
  private validateGroupId(value: string): PeerGroupId {
    if (!GROUP_NAME.test(value)) {
      throw new PeerGroupError('peer group name must match [a-z][a-z0-9_-]{0,31}', 'BAD_GROUP_NAME')
    }
    return PeerGroupId(value)
  }

  /** Require the exact Agent to be live and top-level. */
  private assertRoot(agent: Agent, subject: 'CALLER' | 'MEMBER'): void {
    const live = this.ctx.agents.get(agent.id)
    if (live !== agent) {
      throw new PeerGroupError(
        `${subject.toLowerCase()} Agent is not live`,
        subject === 'CALLER' ? 'CALLER_NOT_LIVE' : 'MEMBER_NOT_ROOT',
      )
    }
    if (!this.ctx.agents.roots().includes(agent)) {
      throw new PeerGroupError(`${subject.toLowerCase()} Agent is delegated`, `${subject}_NOT_ROOT`)
    }
  }

  /** Require an enrolled session id to resolve to a live root. */
  private requireRoot(sessionId: SessionId, subject: 'MEMBER'): Agent {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined || !this.ctx.agents.roots().includes(agent)) {
      throw new PeerGroupError(`session '${sessionId}' is not a live root`, `${subject}_NOT_ROOT`)
    }
    return agent
  }

  /** Project one group without provider-private workspace identities. */
  private projectGroup(group: GroupRecord): PeerGroupView {
    return { id: group.id, name: group.id, members: [...group.members.values()].map(member => this.projectMember(member)) }
  }

  /** Project one member and its current orthogonal status axes. */
  private projectMember(member: MemberRecord): PeerMemberView {
    const agent = this.ctx.agents.get(member.sessionId)
    const live = agent !== undefined && this.ctx.agents.roots().includes(agent)
    const title = agent === undefined ? undefined : foldSessionTitle(agent.session.events)?.title
    return {
      ...this.membership(member),
      ...title === undefined ? {} : { title },
      ...member.workspaceLabel === undefined ? {} : { workspace: member.workspaceLabel },
      availability: live ? 'live' : 'inactive',
      ...live ? { execution: this.execution(agent) } : {},
      writeAccess: member.writeAccess,
    }
  }

  /** Return only the public group-qualified membership identity. */
  private membership(member: MemberRecord): PeerMembership {
    return { groupId: member.groupId, sessionId: member.sessionId, incarnation: member.incarnation }
  }

  /** Stable execution key used by the delivery effect gate. */
  private executionKey(execution: PeerExecutionStatus): string {
    return execution.state === 'blocked' ? `${execution.state}:${execution.reason}` : execution.state
  }

  /** Reject calls through a captured provider after unload. */
  private assertActive(): void {
    if (this.disposed) throw new PeerGroupError('peer-group provider is disposed', 'PROVIDER_DISPOSED')
  }

  /** Settle active waits and drop all process-local authority. */
  private disposeState(): void {
    if (this.disposed) return
    this.disposed = true
    for (const wait of [...this.waits.values()]) {
      this.failWait(wait, 'PROVIDER_DISPOSED', 'peer-group provider was disposed')
    }
    this.groups.clear()
    this.waitLeases.clear()
  }
}

export default LocalPeerGroupRegistry
