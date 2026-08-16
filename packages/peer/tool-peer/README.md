# @deepseek-ai/dsh-tool-peer

English | [中文](README.zh.md)

Model-facing Consumer for `send_to_peer`, `wait_for_peer`, and `list_peers` over [`ctx.peers`](../peer/README.md). Every tool declares generic UI render intent; presentation is a pure function of arguments.

## Tool contract

- `send_to_peer({ peer, message, wait? })` addresses an active root by session id or unique user-set title. Ordinary text returns `{ accepted, deliveryId, messageId, peer, wait? }`, never a reply. A recognized slash line instead runs in the target's command plane and returns `{ accepted, ranAsCommand, commandOk, commandText?, peer, wait? }` without delivering a message. This lets any live root run any command composed in any other live root, including `/permission` and `/compact`; `peer-local.dispatchableCommands` can narrow the available names. A message wait follows the exact claimed turn, while a command wait observes state without a turn.
- `wait_for_peer({ peer, until?, timeoutMs? })` observes one resolved root, may match its initial state, and defaults `until` to `idle | blocked`. A blocked result reports `interaction` or `peer`.
- `list_peers({})` discovers every other active root without prior setup, excluding archived sessions. Rows include session id, optional title and source, optional workspace and preset labels, execution state, write access, and `sharesWritableWorkspace` when that peer and the caller would collide editing one directory. Only user-source titles are valid addresses.

Wait bounds are optional milliseconds in tool input. Validated default and maximum timeouts are deployment tunables on `peer-local`; the Provider resolves each input to a bounded `PeerWaitSpec`. A delivery wait that starts from a non-working target requires an observed effect within `min(timeout, 5000)` milliseconds.

## Model Experience

### Peer collaboration tools

#### What the model sees

The model sees all three schemas. `send_to_peer` distinguishes message acceptance from command execution, `wait_for_peer` states that it observes state rather than a message, and `list_peers` exposes every other active root. Successful results use compact JSON derived from canonical values.

#### Token effect

The schemas add prompt tokens while mounted. Each call adds its arguments and compact JSON result through the ordinary tool log.

#### KV Cache effect

Mounting or unmounting changes the tool-schema prefix. Calls extend only the conversation suffix.

## Known Limitations and Deferred Work

- **No reply channel exists** — acceptance confirms inbox delivery only; a peer replies through a separate delivery.
- **Duplicate user titles are not addresses** — callers must use the session id until titles become unique.
- **No read or fan-out tool exists** — structured session retrieval and comparison workflows remain separate Consumers.
