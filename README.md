# @argszero/dsh-ptc-subcall-guard

Keeps a repeated PTC sub-call id out of the durable session log.

A `run_code` program's sub-calls are numbered per execution, so re-issuing the
same tool call under the same call id mints the same `subCallId`s a second time.
The write path accepts them. The uniqueness rule lives in the Session v4 format,
which is consulted only when the log is next read — where reading is
all-or-nothing, so **one repeat costs the entire session**. This plugin rewrites
the colliding id before the batch is appended, carrying the paired settle along,
and the log stays complete and loadable.

It is a **guard**, not a cleanup: it prevents the duplicate from being written,
and deliberately does not touch a log that already carries one.

## The problem

The reported incident
([#9677](https://github.com/deepseek-ai/deepseek-harness/discussions/9677)) is a
real session of 3,569 events that stopped opening, with:

```
SessionPersistenceCorruptionError: session "<id>": stored log is corrupt:
SessionFormatError: PTC dispatch repeats subCallId
```

Three facts, each read from the shipped source, say why it happened and why
nothing noticed:

1. **The id is per-execution.** `core/tools/src/ptc.ts` mints
   `${callId}:ptc:${n}` with `n` counted inside one `execute()` call. Run the same
   tool call again under the same call id and the sequence starts at 1 again —
   the ids repeat exactly.
2. **The write path never checks.** The batch is appended as built; nothing in
   `SessionPersistence` or in the session's own append path consults the v4
   relationships.
3. **The read path is all-or-nothing.**
   `session-format-v3-to-v4/src/relationships.ts` keeps one map of PTC
   dispatches keyed by `subCallId` and throws on the second start that carries an
   id it has already seen. The entry is never removed, so the rule is "one
   dispatch per id **in the entire log**", and the first repeat fails the whole
   list — 3,568 good events with it.

There is no event on the append path and no hook in the dispatcher, so the seam
is the service instance: `SessionPersistence`'s `open` and `create` are
**prototype** methods, and one own-property write on the instance behind a
`ctx.get` view shadows both for every caller.

## Install

The package is a cordis plugin, so it mounts like any other. Add it to the
profile whose sessions run PTC programs:

```sh
npm install --save @argszero/dsh-ptc-subcall-guard
```

```yaml
# cordis.yml — or the profile's own patch
- insert:
    - id: ptc-subcall-guard
      name: '@argszero/dsh-ptc-subcall-guard'
      inject:
        - sessionPersistence
```

The package ships its own bundle patch, so a profile that installs it by name
gets the row above without writing it by hand.

## What it does

**One own-property write on the service instance.**
`ctx.get('sessionPersistence')` answers `Symbol.for('cordis.original')` with the
object behind the tracking view, and `open` / `create` are prototype methods — so
one write covers every caller, including the agent loop, which is the only caller
that matters and never looks at this plugin. The write is confirmed by reading it
back; a refusal is reported rather than left half installed. Both entry points
are shadowed, because both produce write handles: `create` opens a session,
`open` resumes one.

**A rename, not a deletion.** When a start arrives carrying an id this session
has already started, it is rewritten to `${original}::r1` (then `::r2`, …). The
producer mints `${callId}:ptc:${n}` and never carries `::r`, so the two
namespaces cannot collide, and the candidate is checked against the used set
anyway. Nothing is dropped: the batch stays complete and every later event that
references the id keeps referring to something that exists.

**The paired settle is carried.** The producer does not know about the rename, so
the settle for a renamed dispatch still arrives under the original id. Each start
pushes the id it actually wrote onto a FIFO keyed by the producer's id, and the
settle pops it. The pairing is well defined because the format requires a start
before its settle, so a settle for `X` belongs to the oldest unsettled write of
`X`. This is also why the rewrite fires whenever the batch came back different,
not only when the batch found a *new* collision: a settle for a dispatch an
earlier batch renamed has no record of its own.

**Primed from the stored prefix.** `read` is observed, so the ids already in the
log — which every resume path loads before it appends anything — prime the used
set for free. A guard installed mid-session therefore renames against the whole
log, not only what it has seen since it mounted.

**`rootCallId` is never rewritten.** The rename keeps the dispatch's root, and
the reader's parent test compares roots, so a nested dispatch whose
`parentCallId` still names the original id resolves to the first — never renamed
— start of that id. Nesting needs no special case: a nested id derives from its
parent's original id, so when the parent collides a second time the nested id it
yields is one the ledger has already seen, and is renamed in turn.

**Bounded, per session.** One ledger per stored session, because the invariant is
per log and state shared across sessions would rename ids that never collided.
The number of tracked sessions and the number of collisions reported per session
are both bounded; a session dropped from the map loses only what a re-open
re-learns from its own prefix.

## Configuration

Every field is optional. A value that cannot be honoured is **refused at mount**,
never silently defaulted: a misspelled `mode` that mounts and guards nothing is
how an operator comes to believe the session log is protected when it is not.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` installs nothing at all. |
| `mode` | `'repair'` | `'observe'` reports a collision and appends the batch unchanged, for measuring the shape before repairing it. |
| `maxReportedRepairs` | `20` | Collisions reported into the log, per session. |
| `maxTrackedSessions` | `128` | Sessions that keep a ledger; the least recently opened is dropped. |

## What it is not

- **Not a repair of the past.** A log that already carries a duplicate stays
  unloadable; this plugin prevents the write, and rewrites nothing on disk.
- **Not a change to the producer.** The ids `run_code` mints are untouched, and
  the format validator is not relaxed.
- **Not a guard on a pre-existing handle.** A write handle obtained before the
  plugin mounted is not wrapped.
- **Not retroactive across a crash.** The rewrite happens in the append path, so
  a batch that reaches the log without it is written as built.

## Supported lines

Probed against the published harness lines below; a line that fails the probe is
removed from `peerDependencies` rather than left claimed.

| Line | Representative |
| --- | --- |
| `0.1.7-rc` | `dsh-session-persistence@0.1.7-rc.2` |
| `0.2.0-rc` | `dsh-session-persistence@0.2.0-rc.2` |
| `0.2.1-alpha` | `dsh-session-persistence@0.2.1-alpha.2` |

The seam is two facts about the shipped implementations — `open` and `create`
living on the persistence class's **prototype**, and cordis answering a service
view with the instance behind it — so the probe runs the suite with the whole
line pinned, and the suite's witness spec asserts both against the installed
package rather than restating them.

## Development

```sh
npm install
npm test              # type-check, build, run every spec
npm run test:inject   # mutate one promise at a time; every mutant must be caught
npm run probe:lines   # pin each supported line in a scratch tree and run the suite
```

`test/witness.spec.mjs` is the one that cannot be faked: a real cordis context,
the real JSONL persistence backend, and a real session written and read back. It
writes a log carrying a repeated `subCallId`, watches the backend refuse to open
it, then mounts the guard and watches the same shipment keep the session
readable. The rest of the suite drives the plugin over a stand-in service, so it
can assert decisions without a real backend in the loop.
`scripts/inject-defects.mjs` removes one promise at a time and requires the suite
to notice — an arm that leaves the suite green is reported as SILENT, not as a
pass.

## License

MIT © 2026 argszero
