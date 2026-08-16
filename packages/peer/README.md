# peer/ — cross-session root collaboration

English | [中文](README.zh.md)

This family gives every live root Agent zero-setup discovery, ordinary follow-up delivery, and bounded peer-state waits. It does not create Agents or alter subagent ancestry.

| Package | Role | ctx key |
|---|---|---|
| [`peer/`](peer/README.md) | Defines discovery, addressing, delivery, waits, and stable failures | `ctx.peers` |
| [`peer-local/`](peer-local/README.md) | Provides process-local root discovery, send-time authority, and wait coordination | Registers `ctx.peers` |
| [`tool-peer/`](tool-peer/README.md) | Exposes peer listing, delivery, and waits to models | Registers with `ctx.tools` |

The proposed [zero-setup root-peer collaboration](../../.agents/notes/proposed/feature/2026-08-15-zero-setup-root-peer-collaboration.md) Agent Note owns the design. Public semantics are catalogued in [docs/subsystems/peers.md](../../docs/subsystems/peers.md).
