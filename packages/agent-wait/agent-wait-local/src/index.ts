/**
 * Process-local Service Provider for `ctx.agentWaits`.
 * @module @deepseek-ai/dsh-agent-wait-local
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  AgentWaitEpoch,
  AgentWaitLeaseId,
  AgentWaitRegistry,
} from '@deepseek-ai/dsh-agent-wait'
import type {
  AgentWaitAcquireRequest,
  AgentWaitChangedListener,
  AgentWaitChangeRead,
  AgentWaitCursor,
  AgentWaitLease,
  AgentWaitLeaseView,
  AgentWaitSnapshot,
  AgentWaitTermination,
  AgentWaitTransition,
} from '@deepseek-ai/dsh-agent-wait'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

const PROCESS_EPOCH = AgentWaitEpoch(randomUUID())
let processRevision = 0
let nextLeaseSequence = 0

/** Configuration for retained process-local wait history. */
export interface Config {
  /** Maximum committed transitions retained for cursor catch-up. */
  readonly retainedTransitionLimit: number
}

/** Mutable state for one active lease; callers receive only detached projections. */
interface TrackedLease {
  readonly id: AgentWaitLeaseId
  readonly view: AgentWaitLeaseView
  readonly agent: Agent | undefined
  active: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Transition fields supplied before the registry assigns the commit cursor. */
type PendingTransition =
  | { readonly kind: 'acquired'; readonly lease: AgentWaitLeaseView }
  | {
    readonly kind: 'ended'
    readonly lease: AgentWaitLeaseView
    readonly termination: AgentWaitTermination
  }

/**
 * In-memory wait registry for one process. Provider replacement preserves the
 * process epoch and advances a revision barrier, so old cursors refresh rather
 * than treating replacement state as continuous.
 */
export class LocalAgentWaitRegistry extends AgentWaitRegistry {
  static Config: z<Config> = z.object({
    retainedTransitionLimit: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  })

  private readonly retainedTransitionLimit: number
  private readonly active = new Map<AgentWaitLeaseId, TrackedLease>()
  private readonly transitions: AgentWaitTransition[] = []
  private readonly listeners = new Set<AgentWaitChangedListener>()
  private readonly notifications: AgentWaitCursor[] = []
  private revision = ++processRevision
  private retentionFloor = this.revision
  private notifying = false
  private disposed = false

  /**
   * Create one provider generation inside the process epoch.
   * @param ctx - Cordis context that owns the Service Provider.
   * @param config - validated retained-transition bound.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.retainedTransitionLimit = config.retainedTransitionLimit
    ctx.effect(() => () => { this.disposeState() }, 'agentWaits.disposeState()')
    ctx.on('agent/disposed', ({ agent }) => {
      for (const lease of [...this.active.values()]) {
        if (lease.agent === agent) this.end(lease, 'released')
      }
    })
  }

  acquire(request: AgentWaitAcquireRequest): AgentWaitLease {
    this.assertActive()
    const lifetime = request.lifetime
    if (lifetime.kind === 'observation'
      && (!Number.isFinite(lifetime.timeoutMs)
        || lifetime.timeoutMs <= 0
        || lifetime.timeoutMs > MAX_TIMER_DELAY_MS)) {
      throw new Error(
        `agent wait observation timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    const id = AgentWaitLeaseId(`${PROCESS_EPOCH}:${++nextLeaseSequence}`)
    const sessionId = lifetime.kind === 'agent' ? lifetime.agent.session.id : lifetime.sessionId
    const view: AgentWaitLeaseView = {
      id,
      sessionId,
      reason: request.reason,
      lifetime: lifetime.kind,
    }
    const tracked: TrackedLease = {
      id,
      view,
      agent: lifetime.kind === 'agent' ? lifetime.agent : undefined,
      active: true,
      timer: undefined,
    }
    this.active.set(id, tracked)
    if (lifetime.kind === 'observation') {
      tracked.timer = setTimeout(() => { this.end(tracked, 'observation-timeout') }, lifetime.timeoutMs)
      tracked.timer.unref()
    }
    this.commit({ kind: 'acquired', lease: this.copyView(view) })
    return {
      id,
      release: () => { this.end(tracked, 'released') },
    }
  }

  snapshot(): AgentWaitSnapshot {
    this.assertActive()
    for (;;) {
      const before = this.cursor()
      const leases = [...this.active.values()].map(lease => this.copyView(lease.view))
      const after = this.cursor()
      if (before.revision === after.revision) return { cursor: after, leases }
    }
  }

  changes(after: AgentWaitCursor): AgentWaitChangeRead {
    this.assertActive()
    if (after.epoch !== PROCESS_EPOCH) {
      return { kind: 'refresh', reason: 'epoch-changed', snapshot: this.snapshot() }
    }
    if (after.revision < this.retentionFloor || after.revision > this.revision) {
      return { kind: 'refresh', reason: 'revision-gap', snapshot: this.snapshot() }
    }
    return {
      kind: 'changes',
      after,
      cursor: this.cursor(),
      transitions: this.transitions
        .filter(transition => transition.cursor.revision > after.revision)
        .map(transition => this.copyTransition(transition)),
    }
  }

  onChanged(listener: AgentWaitChangedListener): () => void {
    this.assertActive()
    const dispose = this.ctx.effect(() => {
      this.listeners.add(listener)
      return () => { this.listeners.delete(listener) }
    }, 'agentWaits.onChanged()')
    return () => { void dispose() }
  }

  /** Commit one transition before notifying observers. */
  private commit(input: PendingTransition): void {
    this.revision = ++processRevision
    const transition = { ...input, cursor: this.cursor() } as AgentWaitTransition
    this.transitions.push(transition)
    while (this.transitions.length > this.retainedTransitionLimit) {
      const removed = this.transitions.shift()
      /* v8 ignore next -- the loop condition proves one retained transition exists. */
      if (removed === undefined) break
      this.retentionFloor = removed.cursor.revision
    }
    this.notify(transition.cursor)
  }

  /** End an active lease once and publish its terminal transition. */
  private end(lease: TrackedLease, termination: AgentWaitTermination): void {
    if (!lease.active) return
    lease.active = false
    if (lease.timer !== undefined) clearTimeout(lease.timer)
    lease.timer = undefined
    this.active.delete(lease.id)
    if (this.disposed) return
    this.commit({ kind: 'ended', lease: this.copyView(lease.view), termination })
  }

  /** Drain notifications in commit order while containing every observer failure. */
  private notify(cursor: AgentWaitCursor): void {
    this.notifications.push(cursor)
    if (this.notifying) return
    this.notifying = true
    try {
      let next: AgentWaitCursor | undefined
      while ((next = this.notifications.shift()) !== undefined) {
        for (const listener of [...this.listeners]) {
          try {
            const returned: unknown = listener(next)
            void Promise.resolve(returned).catch((error: unknown) => {
              this.ctx.logger.warn(`agent-wait listener rejected: ${String(error)}`)
            })
          } catch (error: unknown) {
            this.ctx.logger.warn(`agent-wait listener threw: ${String(error)}`)
          }
        }
      }
    } finally {
      this.notifying = false
    }
  }

  /** Release timers and references without publishing from a disappearing service. */
  private disposeState(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.notifications.length = 0
    for (const lease of this.active.values()) {
      lease.active = false
      if (lease.timer !== undefined) clearTimeout(lease.timer)
      lease.timer = undefined
    }
    this.active.clear()
    this.transitions.length = 0
  }

  /** Return the current process-qualified position. */
  private cursor(): AgentWaitCursor {
    return { epoch: PROCESS_EPOCH, revision: this.revision }
  }

  /** Return a detached lease projection. */
  private copyView(view: AgentWaitLeaseView): AgentWaitLeaseView {
    return { ...view }
  }

  /** Return a detached transition and lease projection. */
  private copyTransition(transition: AgentWaitTransition): AgentWaitTransition {
    return transition.kind === 'acquired'
      ? { kind: 'acquired', cursor: { ...transition.cursor }, lease: this.copyView(transition.lease) }
      : {
        kind: 'ended',
        cursor: { ...transition.cursor },
        lease: this.copyView(transition.lease),
        termination: transition.termination,
      }
  }

  /** Reject calls through a captured provider after its fiber unloads. */
  private assertActive(): void {
    if (this.disposed) throw new Error('agent wait registry is disposed')
  }
}

export default LocalAgentWaitRegistry
