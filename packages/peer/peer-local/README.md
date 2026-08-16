# @deepseek-ai/dsh-peer-local

English | [中文](README.zh.md)

Process-local Service Provider for [`@deepseek-ai/dsh-peer`](../peer/README.md). It installs `ctx.peers`, discovers current roots from the Agent registry, folds durable titles, resolves preset labels, classifies current write authority against opaque canonical workspace identity, delivers follow-ups, and maintains the process-wide wait graph.

Only user-source titles are addresses. Resolution is session-id first, then an exact user-title match; zero matches fail as `PEER_NOT_FOUND`, multiple matches as `AMBIGUOUS_PEER`, and the caller as `SELF_PEER`. A wait pins the resolved Agent object, so a later title rename does not retarget it and replacement of that session's root ends it as `PEER_REPLACED`.

Sharing a writable workspace is reported, never enforced. `list()` and `send()` mark `sharesWritableWorkspace` when the caller and that peer both hold write authority over one canonical workspace, so concurrent edits would collide; delivery proceeds either way and the model decides what to delegate. Both sides are classified from current sandbox and approval state at each call, so a permission change takes effect without membership or policy-event subscriptions. Sending rejects `interaction`, permits `peer`, and revalidates both live roots immediately before its side effect.

An archived session keeps its Agent, because archiving only hides its sidebar row. The provider therefore excludes the workspace registry's archived set from discovery and refuses to address it, rather than waking work the human has put out of sight. Where no workspace registry is composed, no session is archived.

Before delivery crosses an asynchronous boundary, the provider synchronously parses the line and resolves it against commands composed for the target Agent. A recognized command runs through `ctx.commands.execute()` with peer attribution and produces no inbox message. Omitted `dispatchableCommands` exposes every composed command, including `/permission` and `/compact`, so any live root has the same command access to another live root as a human typing there. Set `dispatchableCommands` to a list of names without leading slashes to narrow that access; an excluded or unknown slash line remains ordinary message text.

`defaultWaitTimeoutMs` and `maxWaitTimeoutMs` are required positive-integer Cordis config fields with no implicit deployment values; the default must not exceed the maximum. `resolveWait()` defaults the state set to `idle | blocked`, applies the configured default, and caps explicit milliseconds.

Execution observation follows the Agent-wait cursor protocol: snapshot, subscribe after the cursor, drain retained transitions, and replace the projection only after `epoch-changed` or `revision-gap`. A wait after command execution is state-based because the command creates no message turn. Wait cleanup covers match, abort, timeout, caller or target disposal, target replacement, subscription failure, and provider disposal.

## Model Experience

### Process-local peer coordination

#### What the model sees

Nothing directly from `ctx.peers`; the tool Consumer owns model-visible schemas and results.

#### Token effect

Zero direct tokens; discovery and wait edges are runtime state.

#### KV Cache effect

No direct invalidation; the Provider does not assemble model requests.

## Known Limitations and Deferred Work

- **Cold sessions are absent** — delivery and waits operate only on roots active in this process.
- **Canonical workspace identity is provider-local** — cross-process write coordination requires another authority mechanism.
