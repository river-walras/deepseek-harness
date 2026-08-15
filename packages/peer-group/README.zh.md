# peer-group/ — 跨会话同级 agent 协作系列

[English](README.md) | 中文

本系列让不同会话中由人类准入的根 agent（智能体）能够相互寻址、投递普通后续消息并等待有界的同级 agent 状态，而不改变 subagent 祖先关系。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`peer-group/`](peer-group/README.md) | 定义成员资格、授权、投递、等待和抽象注册表 | `ctx.peerGroups` |
| [`peer-group-local/`](peer-group-local/README.md) | 提供进程内成员资格、投递和等待协调 | 注册到 `ctx.peerGroups` |
| [`command-peer/`](command-peer/README.md) | 通过 `/peer` 公开仅限人类的组建操作 | 注册到 `ctx.commands` |
| [`tool-peer/`](tool-peer/README.md) | 向模型公开同级 agent 列表、投递和等待 | 注册到 `ctx.tools` |

拟议的[跨会话同级 agent 协作](../../.agents/notes/proposed/feature/2026-08-14-cross-session-peer-collaboration.md) Agent Note 负责该设计。公开词汇收录于 [docs/subsystems/peer-groups.md](../../docs/subsystems/peer-groups.md)。
