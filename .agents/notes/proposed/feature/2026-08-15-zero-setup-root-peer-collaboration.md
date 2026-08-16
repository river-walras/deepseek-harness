# Agent Note: Zero-setup root-peer collaboration

Status: proposed

English | [中文](2026-08-15-zero-setup-root-peer-collaboration.zh.md)

## Problem

Live root Sessions need lateral discovery and message delivery without human coordination outside the conversation. The [human-formed group proposal](../../rejected/feature/2026-08-14-cross-session-peer-collaboration.md) makes discovery depend on prior membership: `list_peers` lists group members, so a model sees nobody until a human creates a group and adds Sessions. Live testing showed that prerequisite defeats the capability's ordinary use.

Subagent ancestry cannot supply lateral authority because children have an owner and are not roots. At the same time, treating every live root as addressable must expose workspace collisions, preserve command attribution, and prevent a title rename from retargeting an in-flight wait.

## Proposal

Replace `ctx.peerGroups` with `ctx.peers`. Every live root in the process will be mutually discoverable and addressable with no membership state, commands, grants, or membership-removal event. Subagent children will remain excluded solely because they are not roots. This relation will be process-local and will not claim tenant isolation among roots.

`list_peers` will return every other live root. Session ids will be canonical addresses. An exact current user-set title will also resolve when it identifies exactly one other root; automatic titles will remain display-only, and duplicate user titles will fail as `AMBIGUOUS_PEER`. Resolution will prefer session id, reject self-addressing, and occur once per operation.

`send_to_peer` will revalidate both exact live roots immediately before its side effect. Two write-capable roots sharing the provider's opaque canonical workspace identity will receive `sharesWritableWorkspace` as an advisory fact on listings and message acceptance; delivery will proceed because same-workspace collaboration is an ordinary use. Current human sandbox and approval policy will govern the classification without a policy listener or durable membership event.

The provider will synchronously parse each line before ordinary delivery. A slash line that names a command composed for the target Agent will be dispatched in that root's command plane and create no inbox message. Dispatch will return the target Session and command name immediately without awaiting the handler outcome; a rejected execution will be logged and swallowed. Omitted `dispatchableCommands` will expose every composed command, so any live root can start any command in any other live root, including `/permission` and `/compact`, matching what a human typing into that session can do. A deployment can set `dispatchableCommands` to command names without slashes to narrow this authority. `command/run` will attribute execution to the sending Session with `source.kind = 'peer'`; an unrecognized or excluded slash line will remain ordinary message text.

Waits will retain the Agent-wait cursor protocol and bounded configuration. Each wait will pin the resolved target Agent object and install a process-wide cycle-checked edge. A later title rename will not retarget the wait; target replacement, either Agent's disposal, abort, timeout, subscription failure, and provider disposal will settle and clean it up.

Peer delivery will remain an ordinary attributed `Agent.followup()` message. The target message source will retain sender Session and delivery identity for reconstruction, never as authority.

## Alternatives considered

**Keep groups but auto-enroll roots.** Rejected because a universal implicit group retains membership concepts, command and event machinery, and group-qualified identities without restricting discovery or authority.

**Allow automatic titles as addresses.** Rejected because automatic generation can race an operation and produce duplicate display labels that the user did not choose as stable references.

**Resolve titles continuously during waits.** Rejected because a rename could move an active wait to another Agent. Resolving once and pinning object identity preserves the target selected at operation start.

**Reject same-workspace delivery.** Rejected because two roots working in one checkout is the ordinary collaboration case. Reporting `sharesWritableWorkspace` preserves the collision fact while leaving delegation policy with the caller.

**Deliver every slash line as ordinary text.** Rejected because peer roots would be unable to reach direct session controls available to the human. Target-scoped command lookup preserves the target's composed command set, and `dispatchableCommands` supplies the deployment restriction.

**Return the command handler outcome.** Rejected because handler settlement can take tens of seconds and would couple dispatch latency to target work. Admission failures remain synchronous because they are the sender's concern; execution results belong to the target transcript, while an optional wait observes target state.

## Acceptance criteria

- The Service Definition, process-local Provider, tool Consumer, composition, catalogs, and documentation use `ctx.peers` and the `packages/peer/` family; peer-membership commands and events are absent.
- Two live roots discover one another without setup, while a child Agent is absent because it is not a root.
- Session-id addressing, unique user-title addressing, duplicate-title ambiguity, automatic-title exclusion, self rejection, rename-safe waits, and target replacement have focused coverage.
- Send-time tests cover current caller and target liveness, human-interaction blocking, peer-wait delivery, and advisory same-workspace collision reporting under current policy.
- Recognized peer commands return before a slow handler settles, record peer attribution without inbox delivery, contain later rejection, support state-only waits, and fall back to message delivery for unknown or allowlist-excluded names.
- Keyless snapshot scaffolding materializes two roots, renames one through `session.rename`, then lists and sends by title; recording remains a separate real-model action.
- Generated Cordis, tool, graph, persistence, and composition catalogs contain no membership-removal event or peer-group package.

## Risks

Root status is a broad authorization relation that includes another root's composed commands by default. A deployment that hosts mutually distrusting users in one process must add a stronger ownership boundary rather than relying on this provider; a deployment that trusts roots but wants fewer cross-root commands can set `dispatchableCommands`.

User-title ambiguity can appear after a successful list and before a later send. Each operation fails closed against its fresh resolution; callers can use the session id when titles collide.

Process-local discovery does not resume cold Sessions or coordinate writers across processes. Those capabilities require separate activation and authority mechanisms.
