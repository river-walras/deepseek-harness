# @deepseek-ai/dsh-peer

English | [中文](README.zh.md)

Service Definition for `ctx.peers`, the registry for zero-configuration collaboration among live root Agents. Root status is the authorization relation: the Service excludes subagent children but does not provide tenant isolation among roots in one process.

## Addressing and authority

`list(caller)` returns every other live root. Session ids are canonical addresses. A current user-set title is accepted only when it uniquely identifies one other root; automatic titles are display-only. Resolution rejects an absent peer, duplicate user title, or the caller itself.

`send()` revalidates the caller and target immediately before enqueue. It rejects a target blocked on human interaction and permits one blocked only on a peer wait. A shared writable workspace is reported through `sharesWritableWorkspace` on both the listing and the delivery acceptance, and never refuses delivery: two roots editing one directory is the ordinary case, so the decision belongs to whoever reads that fact.

## Delivery and waits

An ordinary line uses `Agent.followup()` and returns durable acceptance ids, never a reply. The target message records the sender session and delivery id as attribution, not authority.

A slash line that resolves to a command composed for the target Agent runs in that root's command plane instead of entering its inbox. Any live root can therefore run any command composed in any other live root, including `/permission` and `/compact`, matching what a human typing into that session can do. The command lifecycle records the sender session through `CommandSource.kind = 'peer'`. Providers may narrow this authority with `dispatchableCommands`.

Standalone waits may match the initial state. A message send wait follows the exact delivered `MessageId`, its `agent/inbox/claimed` turn, and that turn's later state; a command send wait observes state without a message or turn correlation. Each wait resolves its target once, pins the Agent generation, installs a process-wide cycle-checked edge, and cleans up on every completion or failure.

Consumers call `resolveWait()` before `send()` or `wait()` so the provider owns the default predicate and timeout cap.

See the [peer subsystem reference](../../../docs/subsystems/peers.md) and proposed [design note](../../../.agents/notes/proposed/feature/2026-08-15-zero-setup-root-peer-collaboration.md).

## Model Experience

### Peer collaboration service

#### What the model sees

The model sees this service only through `@deepseek-ai/dsh-tool-peer`: listing returns live-root projections, sending returns either message acceptance or a command outcome, and waits return matching state or stable errors.

#### Token effect

Zero direct tokens; the Service Definition registers no tool, prompt, or message.

#### KV Cache effect

No direct invalidation; Consumers own model-visible messages and tool results.

## Known Limitations and Deferred Work

- **Roots are process-local** — discovery does not resume cold sessions or cross a process restart.
- **No tenant isolation** — deployments needing mutually distrusting roots require a separate authorization boundary.
- **No transcript read or fan-out operation** — session-query and workflow Consumers own those tasks.
