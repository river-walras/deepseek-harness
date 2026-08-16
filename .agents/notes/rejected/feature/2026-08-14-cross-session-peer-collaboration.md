# Agent Note: Cross-session peer collaboration

Status: rejected — Live testing refuted the group model: `list_peers` lists members rather than discovering peers, so it returns nothing until a human forms a group; the [zero-setup design](../../proposed/feature/2026-08-15-zero-setup-root-peer-collaboration.md) replaces it

English | [中文](2026-08-14-cross-session-peer-collaboration.zh.md)

## Problem

DeepSeek Harness has a vertical cross-agent relation: `ctx.subagents` gives an owning parent authority over descendants. That relation deliberately does not let sibling or unrelated root Sessions address one another. Ordinary root Sessions can coexist and each can receive human interaction, but no in-process capability lets them form an authorized collaboration group, deliver attributed messages laterally, or wait for another root's execution state.

The existing `AgentStatus` reports `idle | running`, while approval and user-question waits are known only inside their interaction paths or Client presentation. A peer therefore cannot distinguish an idle target from one blocked on a human, and a status snapshot alone can erase a complete short transition. Reusing subagent ancestry would grant the wrong authority and would make members created through that path unable to ask the human because `UserQuestionService` admits only live runtime roots.

The missing capability is lateral and process-local: a human enrolls existing roots, enrolled agents exchange ordinary follow-ups under explicit grants, and bounded waits observe truthful runtime state. The Session log must still reconstruct every model-visible message and tool result without persisting ephemeral wait leases.

## Proposal

Add two complete capability families. `packages/agent-wait/` defines and provides `ctx.agentWaits`, then derives interaction leases from questions and approvals. `packages/peer-group/` defines and provides `ctx.peerGroups`, exposes human-only formation through `/peer`, and exposes listing, delivery, and waiting through three model tools. The base composition mounts both families.

Root `AGENTS.md` needs two standing layout rows for these package groups. A 2,020-word ceiling covers the resulting 1,917-word file with more than five percent headroom; retaining the existing row wording avoids unrelated terminology changes.

This proposal does not change `AgentStatus`, `SessionHeader.parentSession`, `SESSION_FORMAT_VERSION`, `agent-loop`, or `ctx.subagents`. It adds no client or Remote surface. Existing root Session rows and conversation interaction handling remain the human route; `/peer list` supplies group observability.

## Package topology

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-agent-wait` | Service Definition: lease, cursor, snapshot, transition, and gap contracts on `ctx.agentWaits` |
| `@deepseek-ai/dsh-agent-wait-local` | Process-local Service Provider: epoch, active leases, retained transitions, deterministic Agent cleanup, observation expiry |
| `@deepseek-ai/dsh-agent-wait-interaction` | Consumer: question-dispatch leases plus approval-event derivation |
| `@deepseek-ai/dsh-peer-group` | Service Definition: membership, grants, status, delivery, attribution, and waits on `ctx.peerGroups` |
| `@deepseek-ai/dsh-peer-group-local` | Process-local Service Provider: group state, canonical-workspace admission, Agent resolution, inbox delivery, wait graph |
| `@deepseek-ai/dsh-command-peer` | Human Consumer: `/peer` formation and membership commands |
| `@deepseek-ai/dsh-tool-peer` | Model Consumer: `send_to_peer`, `wait_for_peer`, and `list_peers` with generic render intent |

The Service Definition / Service Provider / Consumer separation follows the [capability-seam decision](../../implemented/architecture/2026-06-13-capability-seams.md). Lateral membership remains distinct from the [subagent seam](../../implemented/feature/2026-06-21-subagent-capability-seam.md) and the [interactive side-session proposal](../../proposed/feature/2026-07-08-interactive-side-sessions.md), whose authority and lifecycle needs differ.

## Wait observation

An agent-wait lease has reason `interaction | peer`. The reason describes the outstanding dependency, not the answerer. An exact live `Agent` owns deterministic release; an observed foreign session carries a positive timeout and can terminate as `observation-timeout`. A process epoch plus monotonic revision prevents a restarted counter from implying continuity.

`agent-wait-local` requires a validated positive `retainedTransitionLimit` in cordis.yml because no deployment-independent retention count is implied by the observation protocol. Provider replacement inside one process keeps the process epoch but advances a revision barrier; an older provider cursor receives `revision-gap` rather than treating replacement state as continuous.

`snapshot()` uses a revision/snapshot/revision retry. Consumers take a snapshot, register a change listener, and drain `changes(snapshot.cursor)` before depending on later notifications. Retained transitions are preferred when available because a new snapshot can swallow a complete `working → blocked → working` interval. An epoch mismatch or retention gap yields a fresh snapshot with an explicit `epoch-changed` or `revision-gap` reason.

Leases are ephemeral runtime state and add no `SessionEventMap` member. The model observes a wait only through a logged peer tool result. This preserves the model-visible/logged rule without pretending a process-local condition survived process loss.

## Interaction lifecycle

`UserQuestionService` gains a provider-neutral dispatch hook. It runs after all validation and provider selection, immediately before `provider.ask()`, and its optional acquired resource is disposed exactly once after that call settles. The lease brackets the provider call unconditionally; a synchronous answerer may hold it for a vanishingly short interval, but no timing heuristic reclassifies the interaction.

`ASK_ABORTED`, `CALLER_NOT_LIVE`, `DELEGATED_CALLER`, `EMPTY_QUESTIONS`, `BAD_INTENT`, and `NO_PROVIDER` failures before provider dispatch invoke no hook and publish no wait transition. An abort or provider rejection after dispatch releases the optional acquired lease in the same settlement path. Approval waits derive from the existing `approval/asked` and `approval/decided` events, so `dsh-user-approval` needs no edit.

A provider-dispatched request without an exact `Agent` still emits the lifecycle event. The Consumer acquires no lease because no Session owns the wait.

## Membership and single-writer admission

A membership is `(PeerGroupId, SessionId, membership incarnation)`, never a live `Agent`. One Session may join several groups; `PeerRef { group?, session }` may omit `group` only when caller and target share exactly one group. Grants and wait-graph vertices are group-qualified, and every operation authorizes the current membership incarnation rather than trusting a durable message attribution.

`PeerGroupId` is the human-typed group name after validation against `[a-z][a-z0-9_-]{0,31}`. Matching is exact, with no case folding or normalization; the command Consumer and Service reject invalid names. Any exact current member may add, remove, or dissolve; there is no owner role.

Only exact live runtime roots may be admitted. `/peer create <group>` creates a uniquely named group and enrolls the invoking root. `/peer add <group> <session>` admits another existing root. `/peer remove <group> <session>`, `/peer list [group]`, and `/peer dissolve <group>` use an explicit group and never depend on hidden current-group state. Formation and membership mutation are human-only; model tools use existing grants but cannot create them.

Formation resolves canonical workspace identity inside the Provider and never exposes it as a path. `create` and `add` reject a second write-capable member on the same canonical workspace. A same-workspace non-writer must already be non-escalatable through `sandbox/mode: read-only` and `approval/policy: never`; a member whose write path bypasses `ctx.sandboxPolicy` counts as write-capable. Different canonical workspaces are independent.

A later human policy change is observed rather than vetoed. The human's chosen `sandbox/mode` or `approval/policy` takes effect; if the result would create a second write-capable member, the Provider removes that membership and appends `peer-group/membership-removed` to the removed member's Session after the policy event commits. The deferred append avoids reentering the Session acceptance boundary. No asynchronous notification channel is added; the next list or send result reflects the revoked membership. The enforceable invariant is: at most one write-capable member per canonical workspace, and a member whose later permissions violate it leaves the group.

## Status and delivery

Member status has two axes. Availability is `live | inactive`; execution for a live member is `working | idle | blocked(reason: interaction | peer)`. If both lease reasons exist, `interaction` takes reporting precedence: delivery must fail safe, while a peer-only wait remains deliverable. Inactive targets fail delivery and end waits as `PEER_UNAVAILABLE`; cold activation remains additive later.

Delivery authorizes caller, target, group, grant, and both membership incarnations immediately before enqueue. It mints a `MessageId` and `PeerDeliveryId`, then calls `Agent.followup()` so the Inbox retains its commit-before-mutation behavior. A merge-extensible `MessageSourceMap` member with `form: 'relay'` records group, sender Session, sender incarnation, and delivery id. The service retains those fields as durable attribution but never treats them as authority; every delivery authorizes live membership, incarnation, and grant.

Delivery rejects a target with an outstanding `interaction` lease. It allows a target blocked only on `peer`, because the message may be the input that releases that wait. `send_to_peer` returns delivery acceptance and ids, never a reply; a reply is a separate delivery.

## Wait protocol

Standalone `wait_for_peer` is state-based, may match the initial snapshot, and defaults its predicate to `idle | blocked`; a blocked result reports `interaction` or `peer`. `send_to_peer` defaults to no wait. When its optional `wait: { until?, timeoutMs? }` is present, it follows the exact delivered `MessageId`: observe `agent/inbox/claimed`, capture that message's turn, then wait for that turn rather than any already-active work.

`defaultWaitTimeoutMs` and `maxWaitTimeoutMs` are required validated `Config` fields on `peer-group-local`, and the default cannot exceed the maximum. `resolveWait()` applies these deployment values and the `idle | blocked` predicate default, so operations receive only a resolved, bounded `PeerWaitSpec`.

The base composition supplies `retainedTransitionLimit: 512`, following herdr's equivalent bounded cursor-catch-up ring, `EventHub::MAX_EVENTS = 512`. Its `defaultWaitTimeoutMs: 300000` and `maxWaitTimeoutMs: 1800000` are deployment choices: the default covers a complete agent turn, and the finite maximum prevents a model from parking one call indefinitely.

Every wait is bounded. A send wait beginning against a non-working target requires an observed state change within `min(user timeout, 5000)` milliseconds. If the user's own bound is the shorter deadline, expiry is ordinary `WAIT_TIMEOUT`; otherwise failure to observe delivery effect is distinct `PROMPT_STALLED`.

The wait-for graph installs an edge only after atomically checking for a cycle. An edge includes group, wait id, waiter Session, target Session and incarnation, and predicate. The edge and waiter's `peer` lease leave together in `finally` on predicate match, caller abort, timeout, waiter or target disposal, membership revocation, group dissolve, Provider disposal, target replacement, or subscription failure.

## Delivered design and deviations

Stages 2 through 4 deliver both capability families, the provider-dispatch lifecycle, the human command, the three model tools, generated catalogs, bilingual references, and base-bundle composition. Stage 2 has no behavioral deviation from this proposal. Its required `retainedTransitionLimit` is a repository-rule resolution: retention is deployment-varying configuration, so the Provider has no invented fallback.

Stage 3 changes the generated `packages/core/session/src/known-event-types.ts` vocabulary even though its implementation scope otherwise excludes `packages/core/`; the new durable `peer-group/membership-removed` event must enter the generated known-event set. It also adds `resolveWait(options): PeerWaitSpec` beyond the initial Service Definition declarations. Repository policy requires the owning implementation to resolve an optional request into an explicit spec before `wait()` or `send()` runs, so `resolveWait()` applies the required `defaultWaitTimeoutMs` and `maxWaitTimeoutMs` values without a hidden `?? default` inside execution.

Stage 4 adds a direct `@deepseek-ai/dsh-session-title` dependency to `peer-group-local` so `PeerMemberView.title` folds the latest durable title for `/peer list`; the earlier declaration exposed the field without a producer. The command and tool result formats otherwise preserve the declared behavior. A temporary Stage 4 translation-pairing and `doc-sync` environment failure was cleared before this stage and does not alter the delivered design.

The base bundle supplies `retainedTransitionLimit: 512`, `defaultWaitTimeoutMs: 300000`, and `maxWaitTimeoutMs: 1800000`; these are explicit deployment choices, not package defaults. The rejected policy-write pre-commit veto is absent: formation rejects a second writer, while a later human policy decision takes effect and removes the violating membership.

## Alternatives considered

**Lift subagent parent authority into a general agent directory.** Rejected because ancestry grants vertical lifecycle control, while peer groups need human-issued lateral membership. Weakening the direct-parent and ancestor checks would expand `ctx.subagents` beyond its documented authority and still would not make owned children eligible for human questions.

**Use only `Agent.followup()` as a send-only mailbox.** Rejected because delivery without state observation does not implement the required collaboration protocol. Bounded standalone waits, delivery-correlated waits, cycle rejection, and truthful blocked reasons are current Consumers, not speculative abstractions.

**Pre-commit veto on policy writes.** Rejected because it would require editing the owning write paths and would override an explicit human decision about that human's own session. Per-call escalation already mutates no policy and is structurally denied by `approval/policy: never`. Formation admission belongs in `ctx.peerGroups`; later human policy changes remain authoritative and remove a violating member.

**Classify fast user-question providers as non-human waits.** Rejected because no observable timing cutoff is stable or justified. The lease brackets provider dispatch unconditionally and describes the outstanding interaction rather than the provider implementation.

**Persist wait leases as Session events.** Rejected because leases describe ephemeral process observation. Persisting them would create false blocked state after process loss; logged tool results already preserve every model-visible observation.

**Let agents create or add members.** Rejected because reachability is not membership authority. Human-only commands make the grant explicit, while an enrolled coordinator remains autonomous for listing, delivery, and waits.

**Infer the group for `/peer add` from a current selection.** Rejected because Sessions may join several groups and hidden command state creates ambiguous mutations. Every mutating command carries `<group>` explicitly.

**Require a dedicated multi-agent UI in this slice.** Rejected because members are ordinary root Sessions already visible and answerable in existing conversation surfaces. Grouping, aggregated attention routing, and a dedicated comparison surface remain additive product work.

**Ship worktrees, fan-out, and winner comparison together with messaging.** Rejected because lateral collaboration is safe with formation-time single-writer admission. Parallel write-capable creation needs a separate workspace-isolation capability and a distinct fan-out/comparison identity; it does not require breaking peer membership or delivery.

**Expose an external shell control plane or cold activation.** Rejected for this slice. The product owns in-process roots and existing UI surfaces; remote transport and activation would add wire identity, persistence, liveness, and authorization contracts that no current Consumer needs.

## Acceptance criteria

- Both capability families have separate Service Definition, Service Provider, and current Consumer packages, package READMEs, public declarations, and package-owned invariant companions.
- Agent-wait tests cover lease acquisition/release, exact-Agent disposal, observation timeout, monotonic revisions, snapshot retry, retained transitions, revision gaps, epoch replacement, listener containment, HMR replacement, and Provider disposal.
- User-question tests prove no transition for every pre-dispatch failure and exactly one release for synchronous fulfillment, asynchronous fulfillment, rejection, and post-dispatch abort; approval tests prove asked/decided derivation without editing `dsh-user-approval`.
- Peer-group tests cover root-only admission, multiple groups, ambiguous references, incarnation replacement, live/inactive status, both blocked reasons, corrected single-writer admission, later-policy removal, live authorization, Inbox commit ordering, durable message attribution, delivery rejection/allowance, wait cycles, every wait ending, HMR replacement, and Provider disposal.
- `/peer` implements the exact grammar and reports the required current member fields, while automatic policy removal appends the required Session event and is reflected by the next model list or send operation; the command has a real-composition product snapshot plus a GIF from the real Web flow.
- `send_to_peer`, `wait_for_peer`, and `list_peers` use generic render intent, bounded configuration, delivery correlation, stable errors, and a keyless real-composition transcript snapshot.
- The base bundle mounts the Service Definitions, Providers, command, tools, and relevant invariant companions; focused typecheck, lint, build, hygiene, documentation, and runtime checks pass.

## Risks

The wait graph can deadlock if cycle detection or cleanup is not atomic; first-wins settlement and one lifecycle owner per wait must make edge removal and lease release inseparable. Listener or Provider disposal failures can otherwise strand state or hang teardown.

Lateral messages can create unbounded token and turn cost. Default no-wait delivery, explicit bounded waits, no reply implication, and the absence of fan-out limit the initial amplification, but future rate or conversation budgets may still be needed.

Membership bugs can become authority escalation. Live delivery must re-check group, grant, caller and target incarnations, exact root identity, and blocked-interaction state at commit time; durable source fields cannot substitute for those checks.

The single-writer rule classifies only write paths the Provider can know. Plugins that bypass `ctx.sandboxPolicy` must declare the member write-capable; an incorrect declaration weakens the guarantee. Removing a member after a human policy change preserves human authority but can surprise an active collaboration, so the removed Session must receive the lifecycle event and later peer operations must expose the revoked membership.

Process-local groups and leases disappear on restart, and inactive members are not resumed. These are deliberate limits, but callers must receive loud `PEER_UNAVAILABLE`, epoch-change, and Provider-disposal outcomes rather than indefinite waits or implied persistence.
