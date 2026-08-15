# Peer Groups

English | [中文](peer-groups.zh.md)

The [`@deepseek-ai/dsh-peer-group`](../../packages/peer-group/peer-group) Service Definition gives existing root Agents a lateral collaboration relation independent of subagent ancestry. The registry owns human-formed membership, group-qualified grants, ordinary follow-up delivery, and bounded peer waits.

Source: [`packages/peer-group/peer-group/src/index.ts`](../../packages/peer-group/peer-group/src/index.ts) and [`types.ts`](../../packages/peer-group/peer-group/src/types.ts)

## Membership and addressing

A membership is `(PeerGroupId, SessionId, PeerMembershipIncarnation)`. The incarnation prevents a removed and re-added session from inheriting an old delivery authorization or wait edge. `PeerRef.group` may be absent only when the caller and target share exactly one group; all grants and wait-graph vertices remain group-qualified internally.

```ts check
import type {
  PeerGroupId,
  PeerMembershipIncarnation,
} from '@deepseek-ai/dsh-peer-group'
import type { SessionId } from '@deepseek-ai/dsh-session'

interface PeerRef {
  readonly group?: PeerGroupId
  readonly session: SessionId
}

interface PeerMembership {
  readonly groupId: PeerGroupId
  readonly sessionId: SessionId
  readonly incarnation: PeerMembershipIncarnation
}
```

Only exact runtime roots may be members. Human `/peer` commands form and mutate groups; model tools can list or exercise existing grants but cannot create membership. The grammar is `/peer create <group>`, `/peer add <group> <session>`, `/peer remove <group> <session>`, `/peer list [group]`, and `/peer dissolve <group>`.

Formation resolves canonical workspace identity inside the Provider and rejects a second write-capable member on the same identity. That identity is opaque and never appears as a path in public views. A later human `sandbox/mode` or `approval/policy` change remains effective; a member that would create a second writer is removed from the group and receives a `peer-group/membership-removed` Session event after the policy event commits.

## Availability and execution

Availability is `live | inactive`. Execution is independently `working | idle | blocked`, with blocked reason `interaction | peer`. An inactive target has no execution state. If both reasons exist, `interaction` takes presentation precedence because delivery must reject an outstanding human interaction while a peer wait must remain deliverable.

```ts check
import type { AgentWaitReason } from '@deepseek-ai/dsh-agent-wait'
import type { PeerMembership } from '@deepseek-ai/dsh-peer-group'

type PeerExecutionStatus =
  | { readonly state: 'working' }
  | { readonly state: 'idle' }
  | { readonly state: 'blocked'; readonly reason: AgentWaitReason }

interface PeerMemberView extends PeerMembership {
  readonly title?: string
  readonly workspace?: string
  readonly availability: 'live' | 'inactive'
  readonly execution?: PeerExecutionStatus
  readonly writeAccess: 'write-capable' | 'read-only'
}
```

## Delivery attribution

Delivery authorizes the exact live caller, group membership, incarnation, and grant immediately before enqueue. It mints the target `MessageId` before `Agent.followup()` and carries a durable merge-extensible source. Attribution is not authority: replaying these fields cannot grant membership.

```ts check
import type {
  PeerDeliveryId,
  PeerGroupId,
  PeerMembershipIncarnation,
} from '@deepseek-ai/dsh-peer-group'
import type { SessionId } from '@deepseek-ai/dsh-session'

interface PeerMessageSource {
  readonly kind: 'peer'
  readonly form: 'relay'
  readonly groupId: PeerGroupId
  readonly senderSessionId: SessionId
  readonly senderIncarnation: PeerMembershipIncarnation
  readonly deliveryId: PeerDeliveryId
}
```

`send_to_peer` returns acceptance and ids, never a reply. Its optional `wait: { until?, timeoutMs? }` observes `agent/inbox/claimed` for that exact message and follows the claimed turn. `wait_for_peer` has no message correlation, may match the initial state, and defaults to `idle | blocked`. Both report a blocked reason.

`peer-group-local` requires explicit `defaultWaitTimeoutMs` and `maxWaitTimeoutMs` configuration. `resolveWait()` applies those bounds and the default predicate before an operation receives a `PeerWaitSpec`. The base bundle supplies 300000 and 1800000 milliseconds respectively; its `agent-wait-local` transition ring retains 512 entries.

## Wait graph and endings

Every wait edge is group-qualified and pins waiter session, target session, membership incarnation, wait id, and predicate. Cycle-check and installation are atomic. The waiter's `peer` lease and graph edge leave together in `finally` on match, abort, timeout, either Agent's disposal, membership revocation, group dissolution, Provider disposal, target replacement, or subscription failure.

Inactive targets end as `PEER_UNAVAILABLE`. Delivery rejects `PEER_BLOCKED_INTERACTION` but remains allowed for a target blocked only on `peer`. A delivery wait started against a non-working target requires an observed effect within `min(user timeout, 5000)` milliseconds; the shorter user deadline is `WAIT_TIMEOUT`, otherwise no effect is `PROMPT_STALLED`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeergroups--peergroupregistry-abstract-seam"></a>

### `ctx.peerGroups` — `PeerGroupRegistry` (abstract seam)

Abstract registry for peer membership, authority, delivery, and bounded waits.

Membership operations admit exact live roots and are exposed only through the human command Consumer. Model-facing Consumers may list and use an existing membership but cannot create, add, remove, or dissolve it.

```ts cordis-catalog
/**
 * Resolve optional wait fields against the provider's validated timeout
 * configuration.
 * @param options - optional predicate and timeout from a Consumer boundary.
 * @returns a non-empty predicate and bounded timeout accepted by operations.
 */
abstract resolveWait(options?: PeerWaitOptions): PeerWaitSpec

/**
 * Create a named group and enroll the invoking live root as its first member.
 * @param caller - exact root receiving the human command.
 * @param name - unique non-empty group name.
 * @returns the new group projection.
 */
abstract create(caller: Agent, name: string): Promise<PeerGroupView>

/**
 * Enroll an existing exact live root after workspace write admission.
 * @param caller - exact member receiving the human command.
 * @param groupId - group to change.
 * @param sessionId - existing root session to enroll.
 * @returns the admitted membership projection.
 */
abstract add(caller: Agent, groupId: PeerGroupId, sessionId: SessionId): Promise<PeerMemberView>

/**
 * Revoke one membership and terminate every wait pinned to its incarnation.
 * @param caller - exact member receiving the human command.
 * @param groupId - group to change.
 * @param sessionId - enrolled session to remove.
 */
abstract remove(caller: Agent, groupId: PeerGroupId, sessionId: SessionId): Promise<void>

/**
 * Dissolve a group, revoke every grant, and terminate its waits.
 * @param caller - exact member receiving the human command.
 * @param groupId - group to dissolve.
 */
abstract dissolve(caller: Agent, groupId: PeerGroupId): Promise<void>

/**
 * List groups visible to an exact member, optionally narrowing by id.
 * @param caller - reading live member.
 * @param groupId - optional exact group.
 * @returns fresh projections without canonical workspace identities.
 */
abstract list(caller: Agent, groupId?: PeerGroupId): readonly PeerGroupView[]

/**
 * Authorize and enqueue one ordinary peer follow-up, optionally waiting for
 * the exact claimed message turn to reach a requested state.
 * @param request - caller, peer address, message, optional resolved wait, and cancellation.
 * @returns durable acceptance and optional delivery-correlated observation.
 */
abstract send(request: PeerSendRequest): Promise<PeerSendResult>

/**
 * Install a cycle-checked standalone wait edge and observe the target state.
 * @param request - caller, peer address, resolved bounded predicate, and cancellation.
 * @returns the matching state for the pinned membership incarnation.
 */
abstract wait(request: PeerWaitRequest): Promise<PeerWaitObservation>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/peer-group/peer-group/src/index.ts:50`](../../packages/peer-group/peer-group/src/index.ts)
<!-- END GENERATED cordis-surface -->
