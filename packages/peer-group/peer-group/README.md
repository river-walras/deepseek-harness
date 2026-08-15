# @deepseek-ai/dsh-peer-group

English | [中文](README.zh.md)

Service Definition for `ctx.peerGroups`, the registry for lateral collaboration among existing root Agents. It does not create agents or alter `ctx.subagents`; a membership is the group-qualified tuple of `PeerGroupId`, `SessionId`, and membership incarnation.

## Membership and authority

Human command handlers create groups and change membership. A `PeerGroupId` is the exact human-typed name validated against `[a-z][a-z0-9_-]{0,31}`; neither command nor Service performs case folding or normalization, and both reject invalid names. `/peer create <group>` enrolls the invoking exact live root. Each later add admits another existing live root and mints a new incarnation. Any exact current member may add, remove, or dissolve; groups have no owner role. A `PeerRef` may omit its group only when the caller and target share exactly one group.

Formation rejects a second write-capable member on the same provider-resolved canonical workspace. The canonical identity is never exposed as a path. A later human change to `sandbox/mode` or `approval/policy` wins; if it would create a second writer, the Provider removes that member and appends `peer-group/membership-removed` to the removed member's Session. There is no asynchronous notification channel; the next list or send result reflects the removal. Members whose write paths bypass `ctx.sandboxPolicy` count as write-capable.

## Status, delivery, and waits

Member views report availability (`live` or `inactive`) separately from execution (`working`, `idle`, or `blocked` with reason `interaction` or `peer`). When both wait reasons exist, `interaction` takes reporting precedence: delivery must fail safe, while a peer-only wait remains deliverable. Inactive targets fail delivery and terminate waits as `PEER_UNAVAILABLE`.

`send()` authorizes the live caller, target membership incarnation, and grant at delivery time, mints a `MessageId` and `PeerDeliveryId`, and routes an ordinary message through `Agent.followup()`. The service retains the message source's group, sender session, sender incarnation, and delivery id but never treats them as authority; at delivery time it authorizes live membership, incarnation, and grant. Delivery is rejected while the target has an `interaction` lease and allowed while it has only `peer` leases.

Standalone waits are state-based and may match the initial snapshot. A send wait follows the exact delivered `MessageId`, its `agent/inbox/claimed` turn, and that turn's later state. Every wait installs a group-qualified, cycle-checked edge and removes the edge plus the caller's `peer` lease on every completion or failure.

Consumers call `resolveWait()` to obtain the provider-owned default predicate and bounded timeout before calling `send()` or `wait()`. This keeps deployment defaults explicit at the Service boundary.

See the [peer-group subsystem reference](../../../docs/subsystems/peer-groups.md) and proposed [design note](../../../.agents/notes/proposed/feature/2026-08-14-cross-session-peer-collaboration.md).

## Model Experience

### Peer collaboration service

#### What the model sees

The model sees this service only through `@deepseek-ai/dsh-tool-peer`: listing returns member projections, delivery returns acceptance ids, and waits return logged matching state or stable errors.

#### Token effect

Zero direct tokens; the Service Definition registers no tool, prompt, or message by itself.

#### KV Cache effect

No direct invalidation; Consumers own any new message or tool-result tokens.

## Known Limitations and Deferred Work

- **Groups are process-local** — inactive means no exact live root in the current process, not a promise of cold activation or cross-restart membership recovery.
- **No fan-out, comparison, or worktree isolation** — lateral delivery preserves one-writer admission on shared canonical workspaces; parallel isolated creation is a separate capability.
- **No transcript read operation** — session-reference and session-query Consumers remain the structured cross-session read path.
