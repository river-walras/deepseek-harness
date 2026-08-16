# peer/ — 跨会话根 Agent 协作系列

[English](README.md) | 中文

本系列让每个实时根 Agent 无需配置即可发现其他根、投递普通后续消息并进行有界同级状态等待。它不创建 Agent，也不改变 subagent 祖先关系。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`peer/`](peer/README.md) | 定义发现、寻址、投递、等待和稳定失败 | `ctx.peers` |
| [`peer-local/`](peer-local/README.md) | 提供进程内根发现、发送时权限检查和等待协调 | 注册 `ctx.peers` |
| [`tool-peer/`](tool-peer/README.md) | 向模型公开同级列表、投递和等待 | 注册到 `ctx.tools` |

拟议的[零配置根同级协作](../../.agents/notes/proposed/feature/2026-08-15-zero-setup-root-peer-collaboration.md) Agent Note 负责该设计。公开语义收录于 [docs/subsystems/peers.md](../../docs/subsystems/peers.md)。
