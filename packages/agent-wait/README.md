# agent-wait/ — agent wait-state capability family

English | [中文](README.zh.md)

This family publishes ephemeral reasons that a live agent cannot continue so runtime Consumers can observe interaction and peer waits without scraping a UI.

| Package | Role | ctx key |
|---|---|---|
| [`agent-wait/`](agent-wait/README.md) | Defines leases, revisioned observation, and the abstract registry | `ctx.agentWaits` |
| [`agent-wait-local/`](agent-wait-local/README.md) | Provides the process-local registry | registers on `ctx.agentWaits` |
| [`agent-wait-interaction/`](agent-wait-interaction/README.md) | Derives interaction leases from questions and approvals | consumes `ctx.agentWaits` |

The proposed [cross-session peer collaboration](../../.agents/notes/proposed/feature/2026-08-14-cross-session-peer-collaboration.md) Agent Note owns the design. The public vocabulary is catalogued in [docs/subsystems/agent-wait.md](../../docs/subsystems/agent-wait.md).
