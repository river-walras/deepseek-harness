# agent-wait/ — agent 等待状态能力系列

[English](README.md) | 中文

本系列发布实时 agent（智能体）无法继续执行的临时原因，使运行时消费方无需抓取 UI 即可观察交互等待和同级 agent 等待。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`agent-wait/`](agent-wait/README.md) | 定义租约、带修订号的观察机制和抽象注册表 | `ctx.agentWaits` |
| [`agent-wait-local/`](agent-wait-local/README.md) | 提供进程内注册表 | 注册到 `ctx.agentWaits` |
| [`agent-wait-interaction/`](agent-wait-interaction/README.md) | 从问题和审批派生交互租约 | 消费 `ctx.agentWaits` |

拟议的[跨会话同级 agent 协作](../../.agents/notes/proposed/feature/2026-08-14-cross-session-peer-collaboration.md) Agent Note 负责该设计。公开词汇收录于 [docs/subsystems/agent-wait.md](../../docs/subsystems/agent-wait.md)。
