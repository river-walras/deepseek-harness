# @deepseek-ai/dsh-tool-peer

English | [中文](README.zh.md)

Model-facing Consumer for `send_to_peer`, `wait_for_peer`, and `list_peers` over [`ctx.peerGroups`](../peer-group/README.md). Every tool declares generic UI render intent; presentation is a pure function of arguments.

## Tool contract

- `send_to_peer({ peer, message, wait? })` defaults to no wait and returns `{ accepted, deliveryId, messageId, peer, wait? }`, never a reply. A supplied `wait: { until?, timeoutMs? }` follows the exact delivered message's claimed turn.
- `wait_for_peer({ peer, until?, timeoutMs? })` is state-based, may match the initial snapshot, and defaults `until` to `idle | blocked`. A blocked result reports whether the reason is `interaction` or `peer`.
- `list_peers({ group? })` lists visible groups, while `list_peers({ peer })` returns one resolved member. An omitted group in `PeerRef` succeeds only when shared membership makes it unambiguous.

Group inputs are exact human-typed names matching `[a-z][a-z0-9_-]{0,31}`; invalid names are rejected without case folding or normalization. An automatic policy removal appends a `peer-group/*` event to the removed member's Session without an asynchronous notification channel. The next `list_peers` or `send_to_peer` result reflects that removal.

Wait bounds are optional milliseconds in tool input. Validated default and maximum timeouts are deployment tunables on `peer-group-local`; the Provider resolves each input to a bounded `PeerWaitSpec` before invoking the Service. A delivery wait that starts from a non-working target requires an observed effect within `min(timeout, 5000)` ms. When the user bound is shorter, expiry is `WAIT_TIMEOUT`; otherwise a missing effect is `PROMPT_STALLED`.

## Model Experience

### Peer collaboration tools

#### What the model sees

The model sees all three schemas. `send_to_peer` states that acceptance is not a reply, `wait_for_peer` states that it observes state rather than a message, and `list_peers` returns current shared-membership rows. Successful results use compact JSON text derived from their canonical values.

#### Token effect

The three stable schemas add prompt tokens while the package is mounted. Each call adds its arguments and compact JSON result to model history through the ordinary tool log.

#### KV Cache effect

Mounting or unmounting the package changes the tool-schema prefix. Calls do not change later schemas; their results extend only the conversation suffix.

## Known Limitations and Deferred Work

- **No reply channel exists** — send acceptance confirms inbox delivery only; a peer replies with a separate peer delivery.
- **No read or fan-out tool exists** — structured session retrieval and later comparison workflows remain separate Consumers.
