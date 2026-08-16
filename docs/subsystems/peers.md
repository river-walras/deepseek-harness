# Peers

English | [中文](peers.zh.md)

The [`@deepseek-ai/dsh-peer`](../../packages/peer/peer) Service Definition lets every live root Agent discover and address every other live root in the process without setup. Subagent children are excluded because they are not roots; peer access does not change subagent ancestry or create a tenant-isolation guarantee.

Source: [`packages/peer/peer/src/index.ts`](../../packages/peer/peer/src/index.ts) and [`types.ts`](../../packages/peer/peer/src/types.ts)

## Discovery and addressing

`list()` returns fresh projections for every other live root in registration order. The session id is the canonical peer address. A current user-set session title is also an address when it resolves to exactly one other root; automatic titles are display-only, and duplicate user titles fail as `AMBIGUOUS_PEER`. Self-addressing and absent peers fail explicitly.

The projection reports the current session title and its source, workspace label, selected preset, execution state, and write classification. Canonical workspace identities remain private to admission checks.

## Delivery and authority

`send()` revalidates the exact caller as a live root, resolves the peer once, and checks the target's current Agent generation immediately before execution or `Agent.followup()`. It rejects an outstanding human interaction, but a target blocked only on a peer wait remains addressable.

The provider synchronously parses each line before ordinary delivery. A slash line that names a command composed for the target Agent runs through that root's command plane and creates no inbox message; all other text uses `Agent.followup()`. With `dispatchableCommands` omitted, any live root can run any command composed in any other live root, including `/permission` and `/compact`, matching a human typing into that session. Deployments can set `dispatchableCommands` to command names without slashes to narrow this authority. `command/run` records the sending session with `source.kind = 'peer'`.

A shared writable workspace is advisory. When two roots both hold write authority over one provider-resolved canonical workspace, the listing row and the delivery acceptance carry `sharesWritableWorkspace`; delivery still proceeds. Both classifications read current sandbox and approval state, so a human policy change takes effect on the next call without mutating peer state or appending a lifecycle event.

Archived sessions are excluded from discovery and refused as addresses. Archiving hides a sidebar row without disposing the Agent, so the registry alone would still expose it as a peer and let a delivery wake work the human cannot see.

Accepted message delivery mints `MessageId` and `PeerDeliveryId` values and records the sender session plus delivery id in the target message source. These attribution fields do not grant authority. A command result instead identifies the command name, success state, optional handler text, and target session.

## Waits

`wait_for_peer` may match the exact resolved root's initial state. A wait attached to an ordinary `send_to_peer` delivery follows that delivery's precise claimed message turn. A wait after command execution is state-based and carries no turn because no message was delivered. All use provider-resolved default predicates and bounded timeouts.

Each wait pins the target Agent object, installs a process-wide cycle-checked edge, and owns a `peer` wait lease. Rename does not retarget an in-flight wait because title resolution occurs once at wait start. Match, abort, timeout, caller or target disposal, target replacement, subscription failure, and provider disposal all remove the edge and lease.

The process-local provider requires `defaultWaitTimeoutMs` and `maxWaitTimeoutMs`. The base bundle supplies 300000 and 1800000 milliseconds. A delivery wait that begins from a non-working target requires an observed effect within `min(timeout, 5000)` milliseconds; the shorter user deadline yields `WAIT_TIMEOUT`, otherwise absence of an effect yields `PROMPT_STALLED`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeers--peerregistry-abstract-seam"></a>

### `ctx.peers` — `PeerRegistry` (abstract seam)

Abstract registry for active-root discovery, lateral delivery, and bounded waits.

Root status is the process-local authorization relation. It is not tenant isolation: every live root in one single-user process can address every other live root, including ACP, SDK, and UI roots.

```ts cordis-catalog
/**
 * Resolve optional wait fields against the provider's validated timeout configuration.
 * @param options - optional predicate and timeout from a Consumer input.
 * @returns a non-empty predicate and bounded timeout accepted by operations.
 */
abstract resolveWait(options?: PeerWaitOptions): PeerWaitSpec

/**
 * List every other active root after revalidating the exact caller as a root.
 * @param caller - exact root requesting discovery.
 * @returns fresh peer projections in root registration order.
 */
abstract list(caller: Agent): readonly PeerView[]

/**
 * Resolve one peer once, authorize, and either run its recognized command or enqueue a follow-up.
 * @param request - caller, peer address, line, optional resolved wait, and cancellation.
 * @returns the command outcome or durable message acceptance, plus any requested observation.
 */
abstract send(request: PeerSendRequest): Promise<PeerSendResult>

/**
 * Resolve one peer once, install a process-wide cycle-checked wait edge, and observe its state.
 * @param request - caller, peer address, resolved bounded predicate, and cancellation.
 * @returns the matching state of the exact resolved Agent generation.
 */
abstract wait(request: PeerWaitRequest): Promise<PeerWaitObservation>
```

Types: [Agent](core.md)

Source: [`packages/peer/peer/src/index.ts:47`](../../packages/peer/peer/src/index.ts)
<!-- END GENERATED cordis-surface -->
