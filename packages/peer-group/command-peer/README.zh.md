# @deepseek-ai/dsh-command-peer

[English](README.md) | 中文

用于组建同级 agent 组的人类命令消费方。它保留一套没有隐式当前组的明确语法：

```text
/peer create <group>
/peer add <group> <session>
/peer remove <group> <session>
/peer list [group]
/peer dissolve <group>
```

`<group>` 是匹配 `[a-z][a-z0-9_-]{0,31}` 的精确人类输入名称。命令会拒绝无效名称，并且不进行大小写折叠或规范化。

`create` 将发起命令的精确实时根 Agent 加入组。任何精确的当前成员都可以添加、移除或解散组；不存在所有者角色。变更通过 `ctx.peerGroups` 路由，agent（智能体）不会获得变更成员资格的工具。`list` 报告当前组 id、会话标题和 id、工作区标签、可用性、执行状态和阻塞原因。自动策略移除没有异步命令通知；后续命令输出会报告当前成员资格。

## 模型体验

### 人类命令执行

#### 模型看到什么

不会直接看到任何内容；`/peer` 在模型派发前处理，命令生命周期记录保持对模型隐藏。

#### Token 影响

直接 token 为零；命令结果渲染给人类，而不插入模型请求。

#### KV Cache 影响

不会直接失效；命令处理不改变请求前缀。

## 已知限制与延期工作

- **仅限人类组建** — 模型可以使用现有授权，但不能自行引导或变更组成员资格。
