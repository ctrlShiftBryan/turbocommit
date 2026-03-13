# Async Two-Phase Commits

## Context

The Stop hook currently blocks 15-30s on 3 sequential `spawnSync` calls to
`claude -p --model haiku` (condense + title + body). The goal is to commit
instantly (<500ms) with raw data, then refine the message asynchronously in
a detached background process.

## Design

### Phase 1 — Fast Commit (sync, in Stop hook)

- Skip all LLM calls (condense, title agent, body agent)
- Title: `extractHeadline(effectivePairs)` — instant, from transcript
- Body: raw formatted transcript prefixed with `[tc-pending]` tag on first line
- Include continuation ref, pending/planning sections, coauthor — all instant
- `git add -A && git commit` as today
- Save a **refine manifest** JSON with everything phase 2 needs
- Spawn detached Node.js child to run phase 2
- Exit — Claude Code unblocked

### Phase 2 — Refine (async, detached background process)

- Acquire lock file (one refine at a time per repo)
- Verify HEAD still matches the SHA from phase 1
- Run condense → title agent → body agent (same as today, just backgrounded)
- `git commit --amend` with the rich message
- Update watermark with new SHA
- Push if autoPush configured
- Release lock, cleanup manifest

### Placeholder Tag

`[tc-pending]` — first line of body in phase 1 commits. Short, grep-able,
namespaced. Removed when phase 2 amends.

### Config

New `mode` property:

```jsonc
{
  // "async" (default) → instant commit + background refine
  // "sync"            → original blocking behavior
  "mode": "async"
}
```

Async is the new default. `"sync"` preserves the old behavior for anyone
who wants it.

## Implementation

### Step 1: `lib/git.js` — add `amendCommit` + `headSha`

```js
function amendCommit (cwd, headline, body) {
  git('add -A', { cwd })
  git(`commit --amend -m "${esc(headline)}" -m "${esc(body)}" --no-verify`, { cwd })
  return git('rev-parse HEAD', { cwd })
}

function headSha (cwd) {
  return git('rev-parse HEAD', { cwd })
}
```

Files: `lib/git.js`

### Step 2: `lib/lock.js` — new file, ~50 lines

- `lockPath(root)` → `<gitDir>/turbocommit/refine.lock`
- `acquireLock(root, sha, timeoutMs=60000)` — write PID+SHA+timestamp, poll
  if already locked, detect stale locks (dead PID or >5min old)
- `releaseLock(root)` — unlink
- `isLockStale(lockData)` — check PID alive via `process.kill(pid, 0)`

Lock file format: `{"pid":12345,"sha":"abc...","started":1710000000000}`

Files: `lib/lock.js` (new)

### Step 3: `lib/session.js` — add refine manifest helpers

- `refineDir(root)` → `<gitDir>/turbocommit/refine/`
- `saveRefineManifest(root, sha, data)` — write JSON
- `readRefineManifest(root, sha)` — read JSON
- `cleanupRefineManifest(root, sha)` — delete
- Update `cleanupStale()` to sweep `refine/` directory

Manifest contains: `{ sessionId, transcriptPath, effectivePairs, config,
continuation, pendingSections, coauthor, pairCount }` — everything phase 2
needs to avoid re-deriving.

Files: `lib/session.js`

### Step 4: `lib/refine.js` — new file, phase 2 logic

~100 lines. `refine(manifestPath)`:

1. Read manifest JSON
2. `acquireLock(root, sha)`
3. `headSha(root) === sha` → if not, log `refine-skip`, release, exit
4. Reconstruct pairs from manifest's `effectivePairs`
5. `condensePairs()` if enabled
6. `runTitleAgent()` → rich title
7. `runBodyAgent()` → rich body
8. Rebuild full body: continuation + planning sections + body + coauthor
9. `wrapText()` if configured
10. `amendCommit(root, title, body)`
11. `saveWatermark(root, sessionId, pairCount, newSha)`
12. Push if autoPush + remote exists
13. `cleanupRefineManifest()`
14. `releaseLock()`
15. Log `refine-success` or `refine-fail`

Files: `lib/refine.js` (new)

### Step 5: `lib/run.js` — branch on `config.mode`

In `run()`, after bail-condition checks and `logEvent('start')`:

```
if (mode !== 'sync') {
  // Phase 1: fast commit
  headline = extractHeadline(effectivePairs)
  body = '[tc-pending]\n\n' + formattedTranscript
  // ... continuation, pending, coauthor (all instant) ...
  sha = addAndCommit(root, headline, wrappedBody + tag)
  saveRefineManifest(root, sha, { ... })
  saveWatermark(root, sessionId, pairs.length, sha)
  spawnRefine(manifestPath)  // detached child
  cleanup()
  return
}
// else: existing sync path unchanged
```

`spawnRefine()`:
```js
const child = spawn(process.execPath, [cliPath, 'hook', 'refine', manifestPath], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, TURBOCOMMIT_DISABLED: '1' }
})
child.unref()
```

Uses `process.execPath` for the exact Node binary (no PATH dependency).

Files: `lib/run.js`

### Step 6: `cli.js` — add `refine` hook subcommand

In `cmdHook()`:
```js
case 'refine':
  runRefine(argv[1])  // argv[1] = manifest path
  return
```

Note: `refine` reads its manifest from a file path arg, not stdin (since
it's spawned detached, not piped from Claude Code).

Files: `cli.js`

### Step 7: `README.md` — add `mode` to config heredoc

Add `"mode": "async"` with comment explaining the two options.

Files: `README.md`

## Race Conditions

| Scenario | Handling |
|----------|----------|
| Next stop fires while phase 2 running | Phase 1 commits on top of HEAD (which is still original SHA since amend hasn't happened). Phase 2a sees HEAD mismatch → skips. Phase 2b amends latest commit. |
| Two phase 2 processes start simultaneously | Lock file serializes. Second waits, then sees HEAD mismatch → skips. |
| Phase 2 crashes | Lock has PID. Next phase 2 checks `kill(pid, 0)` — dead process = stale lock → removed. Also 5min max-age failsafe. |
| User makes manual commit before phase 2 | HEAD mismatch → phase 2 skips. Placeholder commit preserved with raw transcript (no data loss). |
| Transcript file deleted before phase 2 | Manifest stores `effectivePairs` directly — no re-read needed. |

## Verification

1. **Unit tests** for each new module:
   - `test/lock.test.js` — acquire, release, stale detection, contention
   - `test/refine.test.js` — amend, HEAD mismatch skip, watermark update, push
   - `test/run.test.js` — new tests for async mode (placeholder tag, spawn, no agent calls)
   - `test/git.test.js` — amendCommit, headSha
   - `test/session.test.js` — manifest save/read/cleanup, stale sweep

2. **Integration test**: full stop hook → verify `[tc-pending]` in commit → wait for refine → verify amended message has no tag and has rich title/body

3. **Manual test**: enable in a real project, run Claude Code, verify:
   - Stop hook returns in <500ms
   - `git log` shows placeholder briefly
   - After ~10-20s, `git log` shows refined message
   - `turbocommit monitor` shows `fast-commit` then `refine-success` events

4. **Existing tests**: run full suite with `node --test` to verify sync mode and all existing behavior unchanged

## Critical Files

- `lib/run.js` — main change: branch sync/async, spawn detached child
- `lib/refine.js` — new: phase 2 background logic
- `lib/lock.js` — new: lock file management
- `lib/git.js` — add amendCommit + headSha
- `lib/session.js` — add refine manifest helpers, update cleanupStale
- `cli.js` — add refine subcommand
- `README.md` — add mode config property

## Implementation Order

1. `lib/lock.js` + `test/lock.test.js` — no deps on existing code
2. `lib/git.js` additions + tests — small, isolated
3. `lib/session.js` manifest helpers + tests
4. `lib/refine.js` + `test/refine.test.js` — depends on 1-3
5. `lib/run.js` async branch + updated tests — the big change
6. `cli.js` refine subcommand
7. `README.md` config update
8. Integration test + manual verification
