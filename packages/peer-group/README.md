# peer-group/ — cross-session peer collaboration family

English | [中文](README.zh.md)

This family lets human-enrolled root agents in different sessions address one another, deliver ordinary follow-ups, and wait for bounded peer state without changing subagent ancestry.

| Package | Role | ctx key |
|---|---|---|
| [`peer-group/`](peer-group/README.md) | Defines membership, grants, delivery, waits, and the abstract registry | `ctx.peerGroups` |
| [`peer-group-local/`](peer-group-local/README.md) | Provides process-local membership, delivery, and wait coordination | registers on `ctx.peerGroups` |
| [`command-peer/`](command-peer/README.md) | Exposes human-only group formation through `/peer` | registers on `ctx.commands` |
| [`tool-peer/`](tool-peer/README.md) | Exposes peer listing, delivery, and waiting to the model | registers on `ctx.tools` |

The proposed [cross-session peer collaboration](../../.agents/notes/proposed/feature/2026-08-14-cross-session-peer-collaboration.md) Agent Note owns the design. The public vocabulary is catalogued in [docs/subsystems/peer-groups.md](../../docs/subsystems/peer-groups.md).
