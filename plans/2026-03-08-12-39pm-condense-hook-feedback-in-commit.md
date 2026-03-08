# Condense Hook Feedback in Commit Messages

## Context

When Claude Code's stop hook blocks with verbose output (build logs, lint results, duplicate code detection), the raw output enters the JSONL transcript as a user message prefixed with `"Stop hook feedback:\n"`. Turbocommit includes this verbatim in the commit message body, bloating it with 50-100+ lines of machine output. We want to summarize it into 2-4 sentences instead.

## Approach

Insert a **condensing step** into the `run.js` pipeline between transcript parsing and agent calls. Hook feedback prompts are detected, run through a haiku summarizer agent, and replaced with concise summaries before the title/body agents ever see them.

Enabled by default. Configurable via `condense` section in `turbocommit.json`.

## Changes

### 1. Detection — `lib/transcript.js`

Add two functions:

- `isHookFeedback(text)` — returns `true` if text starts with `"Stop hook feedback:\n"`
- `truncateHookFeedback(text, maxLines)` — fallback: keeps first 4 lines + `"[... N lines truncated]"` marker

Export both.

### 2. Condense agent — `lib/agent.js`

Add `DEFAULT_CONDENSE_PROMPT`:

```
Summarize this CI/build/lint output in 2-4 sentences.
Focus on: what checks ran, what passed, what failed, and key error details.
Do not include raw logs or file paths.

Output:
{{transcript}}

Respond with ONLY the summary, nothing else.
```

Add `runCondenseAgent(root, condenseCfg, text)`:
- Reuses `renderPrompt()` with `{{transcript}}` placeholder
- Reuses `runAgent()` with `condenseCfg.command || DEFAULT_COMMAND`
- Returns `string | null`

Export both.

### 3. Pipeline integration — `lib/run.js`

Add `condensePairs(root, config, pairs)`:

1. Iterate `pairs`
2. For each pair where `isHookFeedback(pair.prompt)` AND `pair.prompt.length >= minLength` (default 200):
   - Run `runCondenseAgent(root, config.condense || {}, pair.prompt)`
   - Success → replace `pair.prompt` with summary text
   - Failure → replace with `truncateHookFeedback(pair.prompt)`
3. Mutates pairs in place (safe — they're consumed downstream)

Call site in `run()`, after watermark slice, before `formatBody`:

```js
if (config.condense?.enabled !== false) {
  condensePairs(root, config, effectivePairs)
}
```

### 4. Configuration — `README.md`

Add to jsonc heredoc:

```jsonc
"condense": {
  // Summarize verbose stop-hook feedback before agents see it.
  // true/absent -> enabled (default), false -> disabled
  "enabled": true,

  // Command for condensing.
  "command": "claude -p --model haiku",

  // Prompt template. {{transcript}} = raw hook output.
  "prompt": "...",

  // Min chars to trigger condensing. Shorter feedback left as-is.
  "minLength": 200
}
```

### 5. Tests

**`test/transcript.test.js`**:
- `isHookFeedback` true for `"Stop hook feedback:\n..."`, false for regular text, false for null
- `truncateHookFeedback` preserves short text, truncates long text with count, defaults to 4 lines

**`test/agent.test.js`**:
- `runCondenseAgent` uses configured command, returns null on failure, uses custom/default prompt (mirrors existing `runTitleAgent`/`runBodyAgent` test pattern)

**`test/run.test.js`**:
- Hook feedback prompt condensed in commit body (mock condense command with `echo`)
- Short hook feedback left untouched
- Non-hook prompts unaffected
- Agent failure falls back to truncation
- `condense.enabled: false` skips condensing

## Files

| File | Change |
|------|--------|
| `lib/transcript.js` | `isHookFeedback()`, `truncateHookFeedback()` |
| `lib/agent.js` | `DEFAULT_CONDENSE_PROMPT`, `runCondenseAgent()` |
| `lib/run.js` | `condensePairs()`, call in `run()` |
| `README.md` | `condense` config in heredoc |
| `test/transcript.test.js` | Detection + truncation tests |
| `test/agent.test.js` | Condense agent tests |
| `test/run.test.js` | Integration tests |

## Verification

1. Run existing tests: `node --test`
2. Run new tests covering detection, condensing, fallback, and config
3. Manual: create a test transcript with a hook feedback prompt, run the pipeline, verify commit body has summary not raw output
4. Verify `condense.enabled: false` preserves old behavior
