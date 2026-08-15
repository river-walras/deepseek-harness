# @deepseek-ai/dsh-command-peer

English | [中文](README.zh.md)

Human command Consumer for peer-group formation. It reserves one explicit grammar with no implicit current group:

```text
/peer create <group>
/peer add <group> <session>
/peer remove <group> <session>
/peer list [group]
/peer dissolve <group>
```

`<group>` is an exact human-typed name matching `[a-z][a-z0-9_-]{0,31}`. The command rejects invalid names and performs no case folding or normalization.

`create` enrolls the invoking exact live root. Any exact current member may add, remove, or dissolve; there is no owner role. Mutations route through `ctx.peerGroups`, and agents receive no membership-mutation tool. `list` reports current group id, session title and id, workspace label, availability, execution state, and blocked reason. Automatic policy removal has no asynchronous command notification; later command output reports current membership.

## Model Experience

### Human command execution

#### What the model sees

Nothing directly; `/peer` is handled before model dispatch and command lifecycle records remain model-hidden.

#### Token effect

Zero direct tokens; command results are rendered to the human rather than inserted into a model request.

#### KV Cache effect

No direct invalidation; command handling does not change request prefixes.

## Known Limitations and Deferred Work

- **Formation is human-only** — a model can use existing grants but cannot bootstrap or mutate group membership.
