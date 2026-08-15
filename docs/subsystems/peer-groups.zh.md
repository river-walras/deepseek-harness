# 同级 Agent 组

[English](peer-groups.md) | 中文

[`@deepseek-ai/dsh-peer-group`](../../packages/peer-group/peer-group) Service Definition 为现有根 Agent 提供独立于 subagent 祖先关系的横向协作关系。注册表拥有人类组建的成员资格、由组限定的授权、普通后续消息投递和有界同级 agent（智能体）等待。

源文件：[`packages/peer-group/peer-group/src/index.ts`](../../packages/peer-group/peer-group/src/index.ts) 和 [`types.ts`](../../packages/peer-group/peer-group/src/types.ts)

## 成员资格与寻址

成员资格为 `(PeerGroupId, SessionId, PeerMembershipIncarnation)`。incarnation 防止已移除再重新加入的会话继承旧的投递授权或等待边。只有当调用方和目标恰好共享一个组时，`PeerRef.group` 才能省略；所有授权和等待图顶点在内部仍由组限定。

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

只有精确的运行时根 Agent 才能成为成员。人类 `/peer` 命令组建并变更组；模型工具可以列出或使用现有授权，但不能创建成员资格。语法为 `/peer create <group>`、`/peer add <group> <session>`、`/peer remove <group> <session>`、`/peer list [group]` 和 `/peer dissolve <group>`。

组建操作在提供方内部解析规范工作区身份，并拒绝同一身份中的第二个可写成员。该身份是不透明的，绝不会作为路径出现在公开视图中。人类后来对 `sandbox/mode` 或 `approval/policy` 的修改仍会生效；会产生第二个写入者的成员会被移出组，并在策略事件提交后收到一条 `peer-group/membership-removed` Session 事件。

## 可用性与执行

可用性是 `live | inactive`。执行状态与之独立，为 `working | idle | blocked`，其中阻塞原因为 `interaction | peer`。非活动目标没有执行状态。若两种原因同时存在，展示以 `interaction` 为先，因为未结算的人类交互必须拒绝投递，而同级 agent 等待必须保持可投递。

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

## 投递归因

投递在进入队列前立即授权精确实时调用方、组成员资格、incarnation 和授权。它会先铸造目标 `MessageId`，再调用 `Agent.followup()`，并携带一种持久、可合并扩展的来源。归因不是权限：回放这些字段不能授予成员资格。

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

`send_to_peer` 返回接受结果和 id，绝不返回回复。它的可选 `wait: { until?, timeoutMs? }` 观察该精确消息的 `agent/inbox/claimed`，并跟随被认领的轮次。`wait_for_peer` 没有消息关联，可以匹配初始状态，并默认等待 `idle | blocked`。两者都会报告阻塞原因。

`peer-group-local` 要求显式配置 `defaultWaitTimeoutMs` 和 `maxWaitTimeoutMs`。`resolveWait()` 会在操作接收 `PeerWaitSpec` 前应用这些边界和默认谓词。基础组合包分别提供 300000 和 1800000 毫秒，其 `agent-wait-local` 转换环保留 512 个条目。

## 等待图与结束条件

每条等待边都由组限定，并固定等待方会话、目标会话、成员 incarnation、等待 id 和谓词。环路检查与安装是原子操作。等待方的 `peer` 租约与图边在 `finally` 中共同移除，覆盖匹配、中止、超时、任一 Agent dispose（资源释放）、撤销成员资格、解散组、提供方 dispose、替换目标或订阅失败。

非活动目标以 `PEER_UNAVAILABLE` 结束。投递会拒绝 `PEER_BLOCKED_INTERACTION`，但目标仅因 `peer` 阻塞时仍允许投递。针对非工作目标启动的投递等待要求在 `min(user timeout, 5000)` 毫秒内观察到效果；较短的用户截止时间产生 `WAIT_TIMEOUT`，否则无效果产生 `PROMPT_STALLED`。

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
