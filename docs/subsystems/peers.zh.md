# 同级 Agent

[English](peers.md) | 中文

[`@deepseek-ai/dsh-peer`](../../packages/peer/peer) Service Definition 让进程中的每个实时根 Agent 无需配置即可发现并寻址其他所有实时根 Agent。subagent 子节点因不是根而被排除；同级访问不会改变 subagent 祖先关系，也不提供租户隔离保证。

源文件：[`packages/peer/peer/src/index.ts`](../../packages/peer/peer/src/index.ts) 和 [`types.ts`](../../packages/peer/peer/src/types.ts)

## 发现与寻址

`list()` 按注册顺序返回其他所有实时根的最新投影。会话 id 是规范同级地址。当前用户设置的会话标题在恰好解析到另一个根时也可作为地址；自动标题仅用于显示，重复用户标题以 `AMBIGUOUS_PEER` 失败。自寻址和不存在的同级也会显式失败。

投影报告当前会话标题及其来源、工作区标签、所选 preset、执行状态和写入分类。规范工作区身份仅供准入检查使用，不会公开。

## 投递与权限

`send()` 会重新验证精确调用方是实时根，只解析同级一次，并在执行或 `Agent.followup()` 前立即检查目标当前的 Agent 世代。目标有未完成的人类交互时拒绝操作；仅因同级等待而阻塞的目标仍可寻址。

提供方会在普通投递前同步解析每段文本。命名目标 Agent 已组装命令的斜杠文本会通过该根的命令平面运行，不创建收件箱消息；其他文本使用 `Agent.followup()`。省略 `dispatchableCommands` 时，任一实时根都能在其他任一实时根中运行该根组装的任意命令，包括 `/permission` 和 `/compact`，与人类在该会话中键入命令时一致。部署可以把 `dispatchableCommands` 设为不带斜杠的命令名称，以收窄这项权限。`command/run` 通过 `source.kind = 'peer'` 记录发送会话。

共享可写工作区仅作提示。当两个根都对同一个提供方解析的规范工作区持有写入权限时，列表行与投递受理会带上 `sharesWritableWorkspace`；投递仍会进行。两项分类都读取当前沙箱与审批状态，因此人类策略变更会在下一次调用时生效，无需改变同级状态或追加生命周期事件。

已归档会话被排除在发现之外，也不可作为地址。归档只隐藏侧栏行而不处置 Agent，因此仅凭注册表仍会把它暴露为同级，并让一次投递唤醒人类看不见的工作。

接受消息投递会铸造 `MessageId` 和 `PeerDeliveryId`，并在目标消息来源中记录发送方会话和投递 id。这些归因字段不授予权限。命令结果则标识命令名称、成功状态、可选处理器文本和目标会话。

## 等待

`wait_for_peer` 可以匹配已精确解析根的初始状态。附加到普通 `send_to_peer` 投递的等待会跟随该投递的精确消息被认领轮次。命令执行后的等待只基于状态，且由于没有投递消息而不带轮次。三者都使用提供方解析的默认谓词和有界超时。

每项等待都会固定目标 Agent 对象、安装一条进程范围内经过环路检查的边，并拥有一个 `peer` 等待租约。标题重命名不会重定向进行中的等待，因为标题只在等待开始时解析一次。匹配、中止、超时、调用方或目标 dispose、目标替换、订阅失败和提供方 dispose 都会移除边与租约。

进程内提供方要求配置 `defaultWaitTimeoutMs` 和 `maxWaitTimeoutMs`。基础 bundle 提供 300000 和 1800000 毫秒。从非工作目标开始的投递等待要求在 `min(timeout, 5000)` 毫秒内观察到效果；较短的用户期限产生 `WAIT_TIMEOUT`，否则没有效果会产生 `PROMPT_STALLED`。

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
