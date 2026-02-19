const os = require('os')
const path = require('path')
const { loadJson, mergeConfig } = require('./io')
const { parseTranscript, formatBody, extractHeadline } = require('./transcript')
const { runTitleAgent, runBodyAgent } = require('./agent')
const {
  gitRoot, hasChanges, countEmptyMarkers, collectBodies,
  commitEmpty, addAndCommit, softReset, hasCommits
} = require('./git')

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

  // Resolve headline — agent if configured, else transcript
  let headline
  if (config.title?.type === 'agent') {
    headline = runTitleAgent(root, config.title, formattedTranscript)
  }
  headline = headline || extractHeadline(pairs)

  // Resolve body — agent if configured, else transcript
  let body
  if (config.body?.type === 'agent') {
    body = runBodyAgent(root, config.body, formattedTranscript)
  }
  body = body || formattedTranscript

  // Ensure we have at least one commit to work with
  if (!hasCommits(root)) {
    // First commit ever — just add and commit
    if (hasChanges(root)) {
      addAndCommit(root, headline, body)
    } else {
      commitEmpty(root, headline, body)
    }
    return
  }

  if (!hasChanges(root)) {
    // No file changes — absorb prior 🫥 commits, then empty commit
    const markerCount = countEmptyMarkers(root)
    let combinedBody = body

    if (markerCount > 0) {
      const priorBodies = collectBodies(root, markerCount)
      softReset(root, markerCount)
      if (priorBodies.length > 0) {
        combinedBody = priorBodies.join('\n\n---\n\n') + '\n\n---\n\n' + body
      }
    }

    commitEmpty(root, headline, combinedBody)
    return
  }

  // Real changes — absorb contiguous 🫥 commits
  const markerCount = countEmptyMarkers(root)
  let combinedBody = body

  if (markerCount > 0) {
    const priorBodies = collectBodies(root, markerCount)
    softReset(root, markerCount)
    if (priorBodies.length > 0) {
      combinedBody = '## Planning\n\n' + priorBodies.join('\n\n---\n\n') + '\n\n## Implementation\n\n' + body
    }
  }

  addAndCommit(root, headline, combinedBody)
}

module.exports = { run }
