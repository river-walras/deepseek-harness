/**
 * Process-local Service Provider for `ctx.peers`.
 * @module @deepseek-ai/dsh-peer-local
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
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import {
  PeerDeliveryId,
  PeerError,
  PeerRegistry,
  PeerWaitId,
} from '@deepseek-ai/dsh-peer'
import type {
  PeerCommandExecution,
  PeerDeliveryAcceptance,
  PeerErrorCode,
  PeerExecutionStatus,
  PeerSendRequest,
  PeerSendResult,
  PeerView,
  PeerWaitObservation,
  PeerWaitOptions,
  PeerWaitRequest,
  PeerWaitSpec,
  PeerWaitState,
  PeerWriteAccess,
} from '@deepseek-ai/dsh-peer'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
// Type-only: declares `ctx.workspaceRegistry` so the optional `ctx.get` read is
// typed rather than falling through to cordis's `any` overload. The registry is
// composed by the Web bundle, not the shared base, so it stays out of `inject`.
import type {} from '@deepseek-ai/dsh-workspace'

const EFFECT_GATE_MS = 5_000
const DEFAULT_WAIT_STATES: readonly [PeerWaitState, PeerWaitState] = ['idle', 'blocked']

/** Required deployment timeout bounds. */
export interface Config {
  /** Timeout used when a Consumer omits one. */
  readonly defaultWaitTimeoutMs: number
  /** Largest timeout a Consumer may request. */
  readonly maxWaitTimeoutMs: number
  /**
   * Command names a peer may run in another root's command plane, without the
   * leading slash. Omitted means every composed command, matching what a human
   * typing into that session can do. A deployment that does not want one root
   * changing another's permission or history narrows this list; a name outside
   * it is delivered as ordinary message text instead.
   */
  readonly dispatchableCommands?: string[]
}

type CanonicalWorkspaceIdentity = string

/** A line the target's command plane already recognized, carried to execution. */
interface RecognizedCommand {
  readonly commands: CommandRuntime
  readonly name: string
}

/** One peer resolved to an exact active Agent generation. */
interface ResolvedPeer {
  readonly sessionId: SessionId
  readonly agent: Agent
}

/** One atomically installed process-wide wait-for edge. */
interface WaitEdge {
  readonly id: ReturnType<typeof PeerWaitId>
  readonly waiterSessionId: SessionId
  readonly targetSessionId: SessionId
}

/** Mutable settlement state for one bounded wait. */
interface ActiveWait {
  readonly edge: WaitEdge
  readonly waiterAgent: Agent
  readonly targetAgent: Agent
  readonly until: ReadonlySet<PeerWaitState>
  readonly mode: 'standalone' | 'delivery'
  readonly messageId: MessageId | undefined
  readonly initialExecution: string
  readonly resolve: (value: PeerWaitObservation & { readonly turn?: number }) => void
  readonly reject: (error: PeerError) => void
  timeoutTimer: ReturnType<typeof setTimeout> | undefined
  effectTimer: ReturnType<typeof setTimeout> | undefined
  abort: (() => void) | undefined
  claimedTurn: number | undefined
  turnEnded: boolean
  effectObserved: boolean
  active: boolean
}

/** In-memory root-peer registry for one Cordis provider generation. */
export class LocalPeerRegistry extends PeerRegistry {
  static inject = ['agents', 'agentWaits', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    defaultWaitTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
    maxWaitTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
    dispatchableCommands: z.array(z.string()).default(undefined as unknown as string[]),
  })

  private readonly waitLeases = new Map<AgentWaitLeaseView['id'], AgentWaitLeaseView>()
  private readonly edges = new Map<ReturnType<typeof PeerWaitId>, WaitEdge>()
  private readonly waits = new Map<ReturnType<typeof PeerWaitId>, ActiveWait>()
  private waitCursor: AgentWaitCursor
  private disposed = false

  /**
   * Create one process-local provider.
   * @param ctx - Cordis context carrying Agents, policies, and wait observation.
   * @param config - validated default and maximum wait bounds.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    if (config.defaultWaitTimeoutMs > config.maxWaitTimeoutMs) {
      throw new Error('peer-local defaultWaitTimeoutMs must not exceed maxWaitTimeoutMs')
    }
    const snapshot = ctx.agentWaits.snapshot()
    this.waitCursor = snapshot.cursor
    this.replaceWaitSnapshot(snapshot)
    const stopWaitObservation = ctx.agentWaits.onChanged(() => { this.drainWaitChanges() })
    this.drainWaitChanges()

    ctx.effect(() => () => { stopWaitObservation() }, 'peers.stopWaitObservation()')
    ctx.effect(() => () => { this.disposeState() }, 'peers.disposeState()')
    ctx.on('agent/status', ({ agent }) => { this.notifyWaitsFor(agent.id) })
    ctx.on('agent/disposed', ({ agent }) => {
      for (const wait of [...this.waits.values()]) {
        if (wait.waiterAgent === agent) {
          this.failWait(wait, 'WAIT_ABORTED', 'waiting root was disposed')
        } else if (wait.targetAgent === agent) {
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
      throw new PeerError('peer wait requires at least one state', 'WAIT_TIMEOUT')
    }
    const timeoutMs = options.timeoutMs ?? this.config.defaultWaitTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.config.maxWaitTimeoutMs) {
      throw new PeerError(
        `peer wait timeoutMs must be a positive integer no greater than ${this.config.maxWaitTimeoutMs}`,
        'WAIT_TIMEOUT',
      )
    }
    return { until: [...new Set(until)] as [PeerWaitState, ...PeerWaitState[]], timeoutMs }
  }

  list(caller: Agent): readonly PeerView[] {
    this.assertActive()
    this.assertRoot(caller)
    return this.addressableRoots()
      .filter(agent => agent !== caller)
      .map(agent => this.projectPeer(agent, caller))
  }

  async send(request: PeerSendRequest): Promise<PeerSendResult> {
    this.assertActive()
    const target = this.resolvePeer(request.caller, request.peer)
    if (request.signal?.aborted === true) {
      throw new PeerError('peer delivery was aborted before acceptance', 'WAIT_ABORTED')
    }
    // Decided synchronously so ordinary text keeps reaching the target inbox
    // in this same tick; only a real command crosses an await.
    const dispatch = this.commandDispatch(request, target)
    if (dispatch !== undefined) return this.runCommand(request, target, dispatch)
    const deliveryId = PeerDeliveryId(randomUUID())
    const message = createUserMessage({
      content: [{ type: 'text', text: request.message }],
      source: {
        kind: 'peer',
        form: 'relay',
        senderSessionId: request.caller.id,
        deliveryId,
      },
    })
    const delivery: PeerDeliveryAcceptance = {
      deliveryId,
      messageId: message.id,
      peerSessionId: target.sessionId,
      ...this.sharesWritableWorkspace(request.caller, target.agent)
        ? { sharesWritableWorkspace: true as const }
        : {},
    }
    if (request.wait === undefined) {
      this.authorizeDelivery(request.caller, target)
      target.agent.followup(message)
      return { kind: 'message', delivery }
    }

    const settled = await this.runWait({
      caller: request.caller,
      target,
      spec: this.validateSpec(request.wait),
      signal: request.signal,
      mode: 'delivery',
      messageId: message.id,
      initial: this.execution(target.agent),
      start: () => {
        this.authorizeDelivery(request.caller, target)
        target.agent.followup(message)
      },
    })
    if (settled.turn === undefined) throw new PeerError('delivered message was not claimed', 'SUBSCRIPTION_FAILED')
    return { kind: 'message', delivery, settled: { ...settled, turn: settled.turn } }
  }

  /**
   * Run the line in the target's command plane when it recognizes it, so a
   * peer reaches the same surface a human typing into that session reaches.
   * Returns `undefined` when no command plane is composed, the deployment does
   * not expose that command to peers, or the line is not a known command —
   * every one of which falls through to ordinary follow-up delivery.
   *
   * A command produces no inbox message, so a requested wait can only observe
   * state here rather than correlate to one delivered turn.
   */
  private commandDispatch(request: PeerSendRequest, target: ResolvedPeer): RecognizedCommand | undefined {
    const commands = this.ctx.get('commands')
    if (commands === undefined) return undefined
    const parsed = parseCommand(request.message)
    if (parsed === undefined) return undefined
    if (this.config.dispatchableCommands !== undefined
      && !this.config.dispatchableCommands.includes(parsed.name)) {
      return undefined
    }
    return commands.find(target.agent, parsed.name) === undefined ? undefined : { commands, name: parsed.name }
  }

  /** Run an already-recognized command line in the target's command plane. */
  private async runCommand(
    request: PeerSendRequest,
    target: ResolvedPeer,
    recognized: RecognizedCommand,
  ): Promise<PeerSendResult> {
    this.authorizeDelivery(request.caller, target)
    const signal = request.signal ?? new AbortController().signal
    const source = { kind: 'peer' as const, senderSessionId: request.caller.id }
    const executed = await recognized.commands.execute(target.agent, request.message, signal, source)
    if (executed === undefined) {
      throw new PeerError('peer command vanished before execution', 'SUBSCRIPTION_FAILED')
    }
    const command: PeerCommandExecution = {
      peerSessionId: target.sessionId,
      name: recognized.name,
      ok: executed.result.kind === 'success',
      ...executed.result.text === undefined ? {} : { text: executed.result.text },
    }
    if (request.wait === undefined) return { kind: 'command', command }
    const settled = await this.runWait({
      caller: request.caller,
      target,
      spec: this.validateSpec(request.wait),
      signal: request.signal,
      mode: 'standalone',
      messageId: undefined,
      initial: this.execution(target.agent),
      start: () => {},
    })
    return { kind: 'command', command, settled }
  }

  async wait(request: PeerWaitRequest): Promise<PeerWaitObservation> {
    this.assertActive()
    const target = this.resolvePeer(request.caller, request.peer)
    return this.runWait({
      caller: request.caller,
      target,
      spec: this.validateSpec(request.wait),
      signal: request.signal,
      mode: 'standalone',
      messageId: undefined,
      initial: this.execution(target.agent),
      start: () => {},
    })
  }

  /** Run one graph-owned bounded wait and always remove its edge and lease. */
  private async runWait(input: {
    readonly caller: Agent
    readonly target: ResolvedPeer
    readonly spec: PeerWaitSpec
    readonly signal: AbortSignal | undefined
    readonly mode: ActiveWait['mode']
    readonly messageId: MessageId | undefined
    readonly initial: PeerExecutionStatus
    readonly start: () => void
  }): Promise<PeerWaitObservation & { readonly turn?: number }> {
    this.assertRoot(input.caller)
    this.requirePinnedPeer(input.target)
    if (input.signal?.aborted === true) throw new PeerError('peer wait was aborted', 'WAIT_ABORTED')
    const edge: WaitEdge = {
      id: PeerWaitId(randomUUID()),
      waiterSessionId: input.caller.id,
      targetSessionId: input.target.sessionId,
    }
    this.installEdge(edge)
    let lease: AgentWaitLease | undefined
    let record: ActiveWait | undefined
    try {
      lease = this.ctx.agentWaits.acquire({ lifetime: { kind: 'agent', agent: input.caller }, reason: 'peer' })
      const pending = Promise.withResolvers<PeerWaitObservation & { readonly turn?: number }>()
      record = {
        edge,
        waiterAgent: input.caller,
        targetAgent: input.target.agent,
        until: new Set(input.spec.until),
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

  /** Start timeout, delivery-effect, and cancellation settlement. */
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

  /** Evaluate pinned Agent generations and the requested state. */
  private evaluateWait(wait: ActiveWait): void {
    if (!wait.active) return
    if (!this.isExactRoot(wait.waiterAgent)) {
      this.failWait(wait, 'WAIT_ABORTED', 'waiting root was replaced or disposed')
      return
    }
    const currentTarget = this.ctx.agents.get(wait.edge.targetSessionId)
    if (currentTarget === undefined) {
      this.failWait(wait, 'PEER_UNAVAILABLE', 'peer became inactive')
      return
    }
    if (currentTarget !== wait.targetAgent || !this.ctx.agents.roots().includes(wait.targetAgent)) {
      this.failWait(wait, 'PEER_REPLACED', 'peer Agent generation changed')
      return
    }
    const execution = this.execution(wait.targetAgent)
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
      peerSessionId: wait.edge.targetSessionId,
      execution,
      ...wait.claimedTurn === undefined ? {} : { turn: wait.claimedTurn },
    })
  }

  /** Settle one active wait with a stable error. */
  private failWait(wait: ActiveWait, code: PeerErrorCode, message: string): void {
    if (!wait.active) return
    wait.active = false
    wait.reject(new PeerError(message, code))
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

  /** Reject a process-wide wait cycle before publishing the new edge. */
  private installEdge(edge: WaitEdge): void {
    const pending = [edge.targetSessionId]
    const visited = new Set<SessionId>()
    while (pending.length > 0) {
      const sessionId = pending.pop()
      /* v8 ignore next -- the loop condition proves one entry exists. */
      if (sessionId === undefined) break
      if (sessionId === edge.waiterSessionId) {
        throw new PeerError('peer wait would create a cycle', 'WAIT_CYCLE')
      }
      if (visited.has(sessionId)) continue
      visited.add(sessionId)
      for (const current of this.edges.values()) {
        if (current.waiterSessionId === sessionId) pending.push(current.targetSessionId)
      }
    }
    this.edges.set(edge.id, edge)
  }

  /** Resolve an exact session id before a unique user-set title. */
  private resolvePeer(caller: Agent, peer: string): ResolvedPeer {
    this.assertRoot(caller)
    const roots = this.addressableRoots()
    if (this.ctx.agents.roots().some(agent => agent.id === peer) && !roots.some(agent => agent.id === peer)) {
      throw new PeerError(`peer '${peer}' is archived; unarchive it before addressing it`, 'PEER_ARCHIVED')
    }
    const exact = roots.find(agent => agent.id === peer)
    if (exact !== undefined) {
      if (exact === caller) throw new PeerError('a root cannot address itself as a peer', 'SELF_PEER')
      return { sessionId: exact.id, agent: exact }
    }
    const matches = roots.filter((agent) => {
      const title = foldSessionTitle(agent.session.events)
      return title?.source.kind === 'user' && title.title === peer
    })
    if (matches.length > 1) {
      const candidates = matches.map(agent => agent.id).join(', ')
      throw new PeerError(`peer title '${peer}' is ambiguous; use one of these session ids: ${candidates}`, 'AMBIGUOUS_PEER')
    }
    const [match] = matches
    if (match === caller) throw new PeerError('a root cannot address itself as a peer', 'SELF_PEER')
    if (match === undefined) {
      throw new PeerError(
        `no active root peer matches '${peer}'; open the session in the interface before addressing it`,
        'PEER_NOT_FOUND',
      )
    }
    return { sessionId: match.id, agent: match }
  }

  /** Revalidate both exact roots before enqueue. */
  private authorizeDelivery(caller: Agent, target: ResolvedPeer): void {
    this.assertRoot(caller)
    this.requirePinnedPeer(target)
    if (this.blockedReason(target.sessionId) === 'interaction') {
      throw new PeerError(`peer '${target.sessionId}' is blocked on interaction`, 'PEER_BLOCKED_INTERACTION')
    }
  }

  /**
   * Active roots the caller may address. An archived session is one the human
   * put away: it keeps its Agent because archiving only hides the sidebar row,
   * so it stays in the registry and must be excluded here instead.
   */
  private addressableRoots(): readonly Agent[] {
    const archived = this.ctx.get('workspaceRegistry')?.archivedSessionIds
    if (archived === undefined || archived.length === 0) return this.ctx.agents.roots()
    const hidden = new Set(archived)
    return this.ctx.agents.roots().filter(agent => !hidden.has(agent.id))
  }

  /** Whether both roots can write one shared workspace, so concurrent edits would collide. */
  private sharesWritableWorkspace(caller: Agent, peer: Agent): boolean {
    if (this.writeAccess(caller) !== 'write-capable') return false
    if (this.writeAccess(peer) !== 'write-capable') return false
    return this.canonicalWorkspace(caller) === this.canonicalWorkspace(peer)
  }

  /** Require the resolved target to remain the exact active root generation. */
  private requirePinnedPeer(peer: ResolvedPeer): void {
    const current = this.ctx.agents.get(peer.sessionId)
    if (current === undefined) throw new PeerError(`peer '${peer.sessionId}' is inactive`, 'PEER_UNAVAILABLE')
    if (current !== peer.agent || !this.ctx.agents.roots().includes(peer.agent)) {
      throw new PeerError(`peer '${peer.sessionId}' was replaced`, 'PEER_REPLACED')
    }
  }

  /** Require the exact caller Agent to be active and top-level. */
  private assertRoot(agent: Agent): void {
    const live = this.ctx.agents.get(agent.id)
    if (live !== agent) throw new PeerError('calling Agent is not live', 'CALLER_NOT_LIVE')
    if (!this.ctx.agents.roots().includes(agent)) {
      throw new PeerError('calling Agent is delegated', 'CALLER_NOT_ROOT')
    }
  }

  /** Whether one exact Agent remains an active root. */
  private isExactRoot(agent: Agent): boolean {
    return this.ctx.agents.get(agent.id) === agent && this.ctx.agents.roots().includes(agent)
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

  /** Classify one Agent from its current paired policy events. */
  private writeAccess(agent: Agent): PeerWriteAccess {
    return effectiveSandboxMode(agent.session.events) === 'read-only'
      && effectiveApprovalPolicy(agent.session.events) === 'never'
      ? 'read-only'
      : 'write-capable'
  }

  /** Project one active root for a caller, without exposing canonical workspace identity. */
  private projectPeer(agent: Agent, caller: Agent): PeerView {
    const workspaceRoot = this.ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot
    const title = foldSessionTitle(agent.session.events)
    const preset = resolveSessionPreset(agent.session)
    return {
      sessionId: agent.id,
      ...title === undefined ? {} : {
        title: title.title,
        titleSource: title.source.kind === 'user' ? 'user' : 'automatic',
      },
      workspace: basename(workspaceRoot) || workspaceRoot,
      ...preset === undefined ? {} : { preset },
      execution: this.execution(agent),
      writeAccess: this.writeAccess(agent),
      ...this.sharesWritableWorkspace(caller, agent) ? { sharesWritableWorkspace: true as const } : {},
    }
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

  /** Stable execution key used by the delivery-effect timer. */
  private executionKey(execution: PeerExecutionStatus): string {
    return execution.state === 'blocked' ? `${execution.state}:${execution.reason}` : execution.state
  }

  /** Reject calls through a captured provider after unload. */
  private assertActive(): void {
    if (this.disposed) throw new PeerError('peer provider is disposed', 'PROVIDER_DISPOSED')
  }

  /** Settle active waits and drop process-local observation state. */
  private disposeState(): void {
    if (this.disposed) return
    this.disposed = true
    for (const wait of [...this.waits.values()]) {
      this.failWait(wait, 'PROVIDER_DISPOSED', 'peer provider was disposed')
    }
    this.waitLeases.clear()
  }
}

export default LocalPeerRegistry
