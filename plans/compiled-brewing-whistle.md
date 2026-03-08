# Change Defaults to Match BrainFrame Config

## Context

BrainFrame's turbocommit config uses conventional commits, agent-generated bodies, and no coauthor trailer. These are better defaults than the current ones — adopt them project-wide so new users get the BrainFrame experience out of the box.

## Changes

| Setting | Current Default | New Default |
|---|---|---|
| `coauthor` | `true` (auto-detect) | `false` (no trailer) |
| `title.prompt` | Generic imperative mood | Conventional Commit format |
| `body.type` | `"transcript"` | `"agent"` |
| `body.prompt` | Simple summary | Prepend user prompt + summary |

## Files to Modify

### 1. `lib/agent.js` — Update prompt constants

**`DEFAULT_TITLE_PROMPT`** (lines 5-16): Replace with conventional commit prompt:
- Format: `type(scope): subject` or `type: subject`
- Allowed types: feat, fix, chore, refactor, docs, test, perf
- Subject: imperative mood, lowercase start, no trailing period

**`DEFAULT_BODY_PROMPT`** (lines 18-28): Replace with prompt-prepending format:
- Prepend exact first user prompt verbatim
- Follow with concise summary of what was done and why

### 2. `lib/run.js` — Flip body.type and coauthor defaults

**Body type** (lines 154-159): Change from "transcript by default, agent if opted in" to "agent by default, transcript if opted out":
```js
// Before: if (config.body?.type === 'agent')
// After:  if (config.body?.type !== 'transcript')
```

**Coauthor** (line 58): Make `undefined` behave like `false`:
```js
// Before: if (config.coauthor === false) return null
// After:  if (config.coauthor === false || config.coauthor === undefined) return null
```

Users who want auto-detect can set `"coauthor": true`.

### 3. `README.md` (lines 150-192) — Update config reference heredoc

- Flip `"coauthor": true` → `"coauthor": false` with updated comments
- Flip body `"type": "transcript"` → `"type": "agent"` with updated comments
- Replace title prompt string with conventional commit version
- Replace body prompt string with prompt-prepending version

### 4. Tests — Fix broken assertions

~10 tests assume old defaults (auto-detect coauthor, transcript body). Fix by adding explicit `coauthor: true` or `body.type: "transcript"` where tests verify those specific features rather than defaults.

Key tests to fix in `test/run.test.js`:
- Coauthor auto-detect tests → add `coauthor: true` to config
- Claude attribution tests → add `coauthor: true` to config
- Body type tests → verify agent runs by default

In `test/integration.test.js`:
- Co-authored-by integration test → add `coauthor: true`

Add new tests:
- Agent body runs by default when `body.type` absent
- Transcript body when `body.type: "transcript"` (explicit opt-out)
- No coauthor when config is `undefined` (new default)

## Verification

1. `npm test` — all tests pass
2. README heredoc matches actual code defaults exactly
3. Existing users with explicit config are unaffected
