const os = require('os')
const path = require('path')
const { loadJson, mergeConfig } = require('./io')
const { parseTranscript, formatBody, extractHeadline, extractModel } = require('./transcript')
const { runTitleAgent, runBodyAgent } = require('./agent')
const {
  gitRoot, hasChanges, countEmptyMarkers, collectBodies,
  commitEmpty, addAndCommit, softReset, hasCommits
} = require('./git')

/**
 * Map a model ID like "claude-opus-4-6" to a friendly name like "Claude Opus 4.6".
 * Handles both new (claude-opus-4-6) and old (claude-3-5-sonnet-20241022) formats
 * by separating parts into alphabetic (tier) and numeric (version) groups.
 */
function formatModelName (modelId) {
  if (!modelId) return null
  const stripped = modelId.replace(/^claude-/, '')
  if (stripped === modelId) return modelId // not a claude model, use as-is
  const withoutDate = stripped.replace(/-\d{8}$/, '')
  const parts = withoutDate.split('-')
  const alpha = parts.filter(p => /^[a-z]+$/i.test(p))
  const numeric = parts.filter(p => /^\d+$/.test(p))
  if (alpha.length === 0 || numeric.length === 0) return modelId
  const tier = alpha.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  const version = numeric.join('.')
  return `Claude ${tier} ${version}`
}

/**
 * Resolve the Co-Authored-By trailer value.
 * Returns the full trailer line or null.
 */
function resolveCoauthor (config, transcriptPath) {
  if (config.coauthor === false) return null

  if (typeof config.coauthor === 'string') {
    return `Co-Authored-By: ${config.coauthor}`
  }

  // Auto-detect (default when coauthor is true or absent)
  if (!process.env.CLAUDECODE) return null
  const model = extractModel(transcriptPath)
  if (!model) return null
  const name = formatModelName(model)
  return `Co-Authored-By: ${name} <noreply@anthropic.com>`
}

/**
 * Strip trailing Co-Authored-By trailer from a commit body.
 * Used when squashing prior commits to avoid duplicate trailers.
 */
function stripCoauthorTrailer (body) {
  return body.replace(/\n\nCo-Authored-By:[^\n]*$/, '')
}

/**
 * Core auto-commit logic. Called by `turbocommit run`.
 * Reads hook input, checks bail conditions, and commits.
 * Always exits 0 — never blocks Claude, never outputs to stdout.
 */
function run (input) {
  if (process.env.TURBOCOMMIT_DISABLED) return

  let hookInput
  try {
    hookInput = JSON.parse(input)
  } catch {
    return
  }

  // Find git root
  const root = gitRoot()
  if (!root) return

  // Merge global + project config (project wins)
  const globalCfg = loadJson(path.join(os.homedir(), '.claude', 'turbocommit.json'))
  const projectCfg = loadJson(`${root}/.claude/turbocommit.json`)
  const config = mergeConfig(globalCfg || {}, projectCfg || {})
  if (config.enabled !== true) return

  // Don't commit during stop-hook continuations
  if (hookInput.stop_hook_active === true) return

  // Parse transcript
  const pairs = parseTranscript(hookInput.transcript_path)
  const formattedTranscript = formatBody(pairs)

  // Title: agent by default (fast Haiku summary), transcript if opted out.
  // Body: transcript by default (full conversation history), agent if opted in.
  //
  // The two defaults are intentionally opposite. Titles benefit from AI
  // summarization — a prompt like "ok do it" says nothing, but Haiku can
  // read the transcript and produce "Add retry logic to API client" in
  // under a second. Bodies benefit from completeness — the raw transcript
  // is a perfect record of what was discussed and decided, and any summary
  // would lose signal.
  let headline
  if (config.title?.type !== 'transcript') {
    headline = runTitleAgent(root, config.title || {}, formattedTranscript)
  }
  headline = headline || extractHeadline(pairs)

  let body
  if (config.body?.type === 'agent') {
    body = runBodyAgent(root, config.body, formattedTranscript)
  }
  body = body || formattedTranscript

  // Resolve coauthor trailer (appended to final body at each commit site)
  const coauthor = resolveCoauthor(config, hookInput.transcript_path)
  const tag = coauthor ? '\n\n' + coauthor : ''

  // Ensure we have at least one commit to work with
  if (!hasCommits(root)) {
    // First commit ever — just add and commit
    if (hasChanges(root)) {
      addAndCommit(root, headline, body + tag)
    } else {
      commitEmpty(root, headline, body + tag)
    }
    return
  }

  if (!hasChanges(root)) {
    // No file changes — absorb prior 🫥 commits, then empty commit
    const markerCount = countEmptyMarkers(root)
    let combinedBody = body

    if (markerCount > 0) {
      const priorBodies = collectBodies(root, markerCount)
        .map(stripCoauthorTrailer)
      softReset(root, markerCount)
      if (priorBodies.length > 0) {
        combinedBody = priorBodies.join('\n\n---\n\n') + '\n\n---\n\n' + body
      }
    }

    commitEmpty(root, headline, combinedBody + tag)
    return
  }

  // Real changes — absorb contiguous 🫥 commits
  const markerCount = countEmptyMarkers(root)
  let combinedBody = body

  if (markerCount > 0) {
    const priorBodies = collectBodies(root, markerCount)
      .map(stripCoauthorTrailer)
    softReset(root, markerCount)
    if (priorBodies.length > 0) {
      combinedBody = '## Planning\n\n' + priorBodies.join('\n\n---\n\n') + '\n\n## Implementation\n\n' + body
    }
  }

  addAndCommit(root, headline, combinedBody + tag)
}

module.exports = { run, formatModelName, resolveCoauthor }
