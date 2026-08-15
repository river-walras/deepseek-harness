# @deepseek-ai/dsh-agent-wait-local

English | [中文](README.zh.md)

Process-local Service Provider package for [`@deepseek-ai/dsh-agent-wait`](../agent-wait/README.md). It owns active leases, one process epoch, a monotonic revision, retained transitions, exact-Agent disposal, observation expiry, and failure-contained change notifications.

`retainedTransitionLimit` is a required positive-integer Cordis config field that bounds the catch-up suffix; it has no implicit deployment default. A cursor before the retained floor receives `revision-gap` with a replacement snapshot. `snapshot()` retries when its revision moves during projection, and observer failures cannot veto a transition or starve later observers.

The process epoch is minted once per process. Replacing the Provider advances a revision barrier in that epoch, so a cursor from the disposed generation receives `revision-gap` instead of treating the empty replacement state as continuous. Provider disposal clears timers, active records, retained transitions, and observers.

## Model Experience

### Process-local Provider state

#### What the model sees

Nothing directly from `ctx.agentWaits`; the Provider supplies runtime observations to registered Consumers.

#### Token effect

Zero direct tokens; the Provider owns no prompt, tool schema, or rendered result.

#### KV Cache effect

No direct invalidation; Provider state is outside model-request assembly.

## Known Limitations and Deferred Work

- **No durable recovery** — active leases and retained transitions deliberately end with the process epoch.
