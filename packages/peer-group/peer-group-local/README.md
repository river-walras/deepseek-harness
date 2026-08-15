# @deepseek-ai/dsh-peer-group-local

English | [中文](README.zh.md)

Process-local Service Provider package for [`@deepseek-ai/dsh-peer-group`](../peer-group/README.md). It installs `ctx.peerGroups`, owns exact human-typed group names validated against `[a-z][a-z0-9_-]{0,31}` with no case folding or normalization, mints membership incarnations, resolves live root availability and the latest durable session title, classifies write authority against opaque canonical workspace identity, authorizes delivery, and maintains the wait-for graph. The Service rejects invalid group names.

Formation checks the single-writer rule inside `create` and `add`. The Provider observes later `sandbox/mode` and `approval/policy` changes; the human's new policy remains authoritative, and a membership that would violate the rule is removed. Removal appends `peer-group/membership-removed` to the removed member's Session after the policy event commits, creates no asynchronous notification, and is reflected by the next list or send result. Wait cleanup covers predicate match, abort, timeout, either Agent's disposal, membership revocation, group dissolution, target incarnation replacement, subscription failure, and Provider disposal.

`defaultWaitTimeoutMs` and `maxWaitTimeoutMs` are required positive-integer Cordis config fields with no implicit deployment values; the default must not exceed the maximum. `resolveWait()` applies the configured default, caps explicit milliseconds, and defaults the state set to `idle | blocked` before `send()` or `wait()` receives a `PeerWaitSpec`.

Execution state follows the Agent-wait cursor protocol: the Provider snapshots, subscribes after that cursor, drains retained transitions, and replaces its projection only after `epoch-changed` or `revision-gap`. Delivery refuses `interaction`, permits `peer`, and reauthorizes both current incarnations immediately before `Agent.followup()`. Delivery-correlated waits do not match until their own `MessageId` is claimed; standalone waits may match the initial state.

## Model Experience

### Process-local peer coordination

#### What the model sees

Nothing directly from `ctx.peerGroups`; command and tool Consumers own all human- and model-facing output.

#### Token effect

Zero direct tokens; membership, grants, and graph edges are runtime state.

#### KV Cache effect

No direct invalidation; the Provider does not assemble model requests.

## Known Limitations and Deferred Work

- **Inactive members are not resumed** — delivery fails and waits end rather than starting another process or session runtime.
