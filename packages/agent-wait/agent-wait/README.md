# @deepseek-ai/dsh-agent-wait

English | [中文](README.zh.md)

Service Definition for `ctx.agentWaits`, the process-local registry of reasons agents are waiting. It keeps `AgentStatus` unchanged and represents each outstanding dependency with an independently released lease.

## Service contract

- `acquire(request)` publishes an `interaction` or `peer` lease. An exact live `Agent` gives deterministic cleanup; an observed session uses a positive bounded timeout and ends as `observation-timeout` if no owner releases it.
- `snapshot()` returns one process epoch, monotonic revision, and fresh active-lease views. Implementations read revision, build the snapshot, read revision again, and retry if it moved.
- `changes(after)` returns every retained transition after a cursor. An epoch change or revision gap returns a replacement snapshot instead of silently skipping history.
- `onChanged(listener)` is an effect-scoped notification. Consumers register first, drain `changes(snapshot.cursor)`, and then prefer retained transitions over a later snapshot so a complete short wait remains observable.

Leases are runtime observations, not durable session facts. This package adds no `SessionEventMap` member. A model sees a wait only through a Consumer's logged tool result.

See the [agent-wait subsystem reference](../../../docs/subsystems/agent-wait.md) and the proposed [peer collaboration design](../../../.agents/notes/proposed/feature/2026-08-14-cross-session-peer-collaboration.md).

## Model Experience

### Runtime wait state

#### What the model sees

Nothing directly from `ctx.agentWaits`; Consumers decide whether a wait observation belongs in a logged tool result.

#### Token effect

Zero direct tokens; leases, cursors, and transitions are process-local runtime values.

#### KV Cache effect

No direct invalidation; the registry does not assemble or alter model requests.

## Known Limitations and Deferred Work

- **State is process-local** — a process restart changes the epoch and discards every lease; cross-process providers must publish bounded observations rather than imply continuity.
- **Transition retention is finite in Providers** — a lagging subscriber may receive `revision-gap` and must replace local state from the returned snapshot.
