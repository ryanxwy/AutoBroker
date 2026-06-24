# Task 1 report — Record/Replay model seam @ `packages/model`

Status: **DONE**

## What I built (TDD, tests first)

1. **`packages/model/src/recordReplay.test.ts`** (NEW, written FIRST — watched it fail RED with
   "recordingModel is not a function", then implemented to GREEN). 18 tests covering every item in the
   brief's test list:
   - doGenerate round-trip token-for-token (`toEqual` recorded result, modelId + provider identity)
   - doStream round-trip token-for-token + **tee assertion** (recorder still yields a live, complete
     stream to its caller while recording the same ordered parts)
   - per-eventType cursors advancing independently across interleaved doGenerate/doStream replays
   - exhaustion → `ReplayExhaustedError`
   - prompt-hash mismatch → `ReplayPromptMismatchError` with `needsReRecord === true`, plus a test that
     a mismatch does NOT advance the cursor
   - `hashPrompt` stability (same → same; abortSignal/headers-only diff → SAME; different prompt →
     DIFFERENT; different temperature → DIFFERENT)
   - JSONL serialize→parse round-trip, single-line newline-free, blank lines ignored, malformed line throws
   - `JsonlFileSink` appends one line/event and creates the parent dir (nested path)
   - DI seam: wrapper applies, reset restores the real model, wrapper receives (model, alias), and the
     setter refuses outside a test runner (env-clear/restore in a `finally`)

2. **`packages/model/src/recordReplay.ts`** (NEW) — exactly the brief's spec:
   - `TranscriptEvent` / `TranscriptSink` (flat, all-required).
   - `hashPrompt(options)` — SHA-256 over a stable-stringified canon of `prompt + tools + responseFormat
     + temperature + topP + seed`, `.slice(0,16)`. A small `stableStringify` sorts object keys (arrays
     keep order). Excludes `abortSignal` / `headers` by construction (only the listed fields go into the
     canon).
   - `serializeTranscriptEvent` / `parseTranscriptJsonl` (split on `\n`, skip blanks, JSON.parse each,
     throw with the line number on a malformed line).
   - `JsonlFileSink` — `mkdirSync(dirname, {recursive:true})` then `appendFileSync`.
   - `recordingModel(real, sink, ctx)` — Proxy-wraps `real` exactly like `wrapWithGenerateFault`
     (intercepts only doGenerate/doStream; all else `Reflect.get` + bind-to-target). `doStream` TEES via
     a `TransformStream`: each chunk is pushed to a `collected` array AND re-enqueued; the sink append
     fires in `flush()` (source close), so the recorded `result` is the full ordered
     `LanguageModelV3StreamPart[]`.
   - `TraceIndex` — two independent integer cursors (one per eventType). `next()` throws
     `ReplayExhaustedError` past the end, throws `ReplayPromptMismatchError` (no advance) on hash
     mismatch, else advances and returns.
   - `ReplayExhaustedError` / `ReplayPromptMismatchError` (the latter `needsReRecord = true`,
     `expectedHash`, `observedHash`, `eventType`).
   - `replayModel(index, ctx)` — synthesized v3 model (`provider:"autobroker-replay"`, no real provider),
     built like `makeStaticModel`; re-emits recorded stream parts in order.

3. **`packages/model/src/registry.ts`** (EDIT, additive) — mirrors the fault seam exactly:
   - module-global `_harnessModelWrapper` (null default),
   - `__setHarnessModelWrapper` (same test-runner guard + message style as
     `__setHarnessGenerateFaultForTests`), `__resetHarnessModelWrapper`,
   - in `resolveModel`: the wrapper applies on TOP of the (possibly fault-wrapped) model; when null
     (production default) the return is byte-identical to before.

4. **`packages/model/src/index.ts`** (EDIT, additive) — exported the record/replay symbols + the two
   registry seam setters/resetters, keeping the file's import/comment style.

## Key decisions / notes

- **`replayModel.doGenerate/doStream` are `async`.** `index.next()` throws synchronously; without `async`
  the throw escaped as an uncaught synchronous exception instead of a rejected promise, so
  `expect(...).rejects.toThrow` couldn't catch it (this was the single RED on the first GREEN pass — a
  contract bug, fixed, not a test workaround). `async` matches the `LanguageModelV3` `PromiseLike`
  contract: exhaustion/mismatch now surface as promise rejections. `TraceIndex.next` itself stays
  synchronous (test 6 calls it directly and expects a synchronous throw).
- **Tee uses `stream.pipeThrough(new TransformStream(...))`** with the sink append in `flush()`. Recording
  on source-close (not per-chunk) means the recorded result is the complete ordered sequence even if the
  caller cancels early, and there is exactly one append per stream call.
- **`hashPrompt` canon is the brief's listed fields only.** `topK`, `seed` etc. that aren't listed as
  prompt-determining are excluded except where the brief named them (`temperature`/`topP`/`seed`).
  abortSignal/headers are excluded by never being read.
- Stayed entirely inside `packages/model`. No touches to serve-live.mjs, serverHost.ts, workflows, tools,
  or harness. Imports are only `node:crypto` / `node:fs` / `node:path` + `@ai-sdk/provider` types.

## Verification output (run from worktree root)

```
$ pnpm vitest run packages/model/src/recordReplay.test.ts
 Test Files  1 passed (1)
      Tests  18 passed (18)

$ pnpm typecheck            # tsc --build, whole monorepo
(exit 0, no output)

$ pnpm lint:deps
✔ no dependency violations found (629 modules, 1939 dependencies cruised)

$ pnpm vitest run packages/model/   # regression check on the package
 Test Files  7 passed (7)
      Tests  58 passed (58)
```

The full model package (incl. the existing `registryFault.test.ts`) is green — the additive
`resolveModel` edit did not regress the existing fault seam.

## Concerns

None blocking. One forward note (out of scope for this task, flagged for the host-install task): the DI
seam is intentionally a single module-global wrapper, so installing record AND replay simultaneously, or
two wrappers at once, is not supported — the later host-side wiring should set exactly one wrapper per run.
