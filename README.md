# ts-incremental-repro

A composite project replays cached diagnostics forever when its `.tsbuildinfo` records
input versions that match disk but carries `semanticDiagnosticsPerFile` entries from an
earlier state. No input change can ever clear it. Only `--force`, or deleting the
buildinfo, recovers.

Reproduces on every compiler tested, including the released TypeScript 7:

| compiler | version | reproduces |
| --- | --- | --- |
| `typescript` | 5.9.3 | yes |
| `typescript` | 7.0.2 (`latest`) | yes |
| `typescript` | 7.1.0-dev.20260911.1 (`next`) | yes |
| `@typescript/native-preview` | 7.0.0-dev.20260209.1 | yes |
| `@typescript/native-preview` | 7.0.0-dev.20260707.2 (`latest`) | yes |

So this is not specific to the Go port, and it is not something a compiler upgrade
fixes. Checked 2026-09-11.

## Run it

```bash
npm install
npm run repro:tsgo   # exits 1 while the behaviour is present
npm run repro:tsc
```

To try another compiler, install it over the top and point the script at its binary:

```bash
npm install --no-save typescript@7.0.2
node repro.mjs node_modules/.bin/tsc
```

Output:

```
compiler:            node_modules/.bin/tsgo
version:             7.0.0-dev.20260209.1
incremental rebuild: b/src/index.ts(1,10): error TS2305: Module '"a"' has no exported member 'bar'.
--force rebuild:     clean
```

`a/dist/index.d.ts` exports `bar` at that point. The error is replayed from cache.

## The setup

Two composite projects. `b` references `a` and imports `foo` and `bar` from it.

```
a/src/index.ts     export const foo = 1
                   export const bar = 2
b/src/index.ts     import { bar, foo } from 'a'
```

## What `repro.mjs` does

1. Build with `bar` present. Clean. Save `b`'s buildinfo.
2. Remove `bar` from `a`. Rebuild. `b` reports `TS2305`. Save that buildinfo.
3. Restore `bar`. Rebuild. Clean again, so `a/dist/index.d.ts` is byte-identical to step 1.
4. Graft step 1's `fileInfos` version hash for `a/dist/index.d.ts` into step 2's buildinfo,
   and write it as `b`'s buildinfo. Every recorded input version now matches disk; only the
   cached diagnostics are from step 2.
5. Build again.

Step 5 replays `TS2305` against a `.d.ts` that plainly exports `bar`, and keeps doing so on
every subsequent build.

## Why it never recovers

The incremental builder decides what to re-check by diffing the recorded `fileInfos`
versions against disk. They all match, so nothing is re-checked and the cached diagnostics
are re-emitted verbatim. The buildinfo is not even rewritten; its mtime is unchanged
across runs.

`--build --verbose` reports:

```
Project 'b/tsconfig.json' is out of date because buildinfo file 'b/dist/tsconfig.tsbuildinfo'
indicates that program needs to report errors.
Building project 'b/tsconfig.json'...
```

So the project *is* rebuilt on every run. The error flag is the only reason it rebuilds, and
that path restores the program from the buildinfo rather than re-checking it.

Nothing in a normal workflow escapes this state. Verified against the repro:

| action | recovers? |
| --- | --- |
| `touch a/dist/index.d.ts` | no |
| touch `a`'s source and let it re-emit | no (identical bytes, identical hash) |
| rebuild the whole solution | no |
| `--force` | yes |
| delete `b/dist/tsconfig.tsbuildinfo` | yes |

## Scope, and what is not shown here

Step 4 constructs the inconsistent buildinfo directly, because that is the state worth
characterising: once a buildinfo is internally inconsistent in this way, it is an absorbing
state, and callers have no way to detect it. The cached diagnostics are ordinary semantic
errors, indistinguishable from real ones.

**What produced such a buildinfo in the wild is not reproduced here.** It was observed in a
large monorepo where 5 of 66 composite projects had accumulated cached diagnostics that
disagreed with a `--force` rebuild, with no source changes in between. Two candidate races
were tested directly against this setup and neither reproduced:

- rewriting a referenced project's source mid-build, 20 iterations across staggered delays
- two concurrent `tsc -b` processes on the same graph, source flipped between them, 15 iterations

Both recovered every time. So the producer is still unidentified.

## Related

- [microsoft/TypeScript#42769](https://github.com/microsoft/TypeScript/issues/42769): stale errors in tsbuildinfo (closed, PR #48600, 4.6.1)
- [microsoft/TypeScript#49527](https://github.com/microsoft/TypeScript/issues/49527): more stale errors (closed, PR #49543)
- [microsoft/TypeScript#50959](https://github.com/microsoft/TypeScript/issues/50959): added the "program needs to report errors" up-to-date check

## CI

`.github/workflows/repro.yml` runs the repro against three pinned compilers on every push and
weekly. **A green run means the behaviour still reproduces.** A job fails if its compiler
stops replaying the stale diagnostic, which is the signal that this can be closed.

Two further jobs track the floating `typescript@next` and `@typescript/native-preview@latest`
tags. They are `continue-on-error`, since a nightly can break for unrelated reasons; read them
as a signal rather than a gate.
