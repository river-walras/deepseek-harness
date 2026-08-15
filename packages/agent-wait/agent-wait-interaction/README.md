# @deepseek-ai/dsh-agent-wait-interaction

English | [中文](README.zh.md)

Interaction Consumer package for [`ctx.agentWaits`](../agent-wait/README.md). It acquires `interaction` leases around user-question provider dispatch and derives the same reason from existing `approval/asked` and `approval/decided` events without changing `dsh-user-approval`.

A question lease begins only after request validation and provider selection, immediately before the provider call, and ends after that call settles. Pre-dispatch `ASK_ABORTED`, `CALLER_NOT_LIVE`, `DELEGATED_CALLER`, `EMPTY_QUESTIONS`, `BAD_INTENT`, and `NO_PROVIDER` failures publish no transition. The provider's speed and identity do not change the reason: every outstanding approval or question is an `interaction` wait.

Provider dispatch still emits the lifecycle event for a request without an exact `Agent`. The Consumer acquires no lease for that request because no session owns the wait.

An `approval/asked` event acquires a lease only when its Session belongs to the exact live Agent. The matching `approval/decided` id releases it. An unmatched ask remains blocked until a later matching decision, exact-Agent disposal, or Consumer disposal; duplicate live ask ids do not acquire a second lease.

## Model Experience

### Interaction wait derivation

#### What the model sees

Nothing directly from an `interaction` lease; the package observes lifecycles and publishes only process-local state.

#### Token effect

Zero direct tokens; question answers and approval outcomes retain their existing owning Consumers.

#### KV Cache effect

No direct invalidation; deriving a wait does not change request content.

## Known Limitations and Deferred Work

- **Live derivation only** — resumed approval audit history does not recreate wait leases; only lifecycle events appended while this process-local Consumer is mounted contribute current wait state.
