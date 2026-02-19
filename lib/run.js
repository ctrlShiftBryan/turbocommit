const { loadJson } = require('./io')
const { parseTranscript, formatBody, extractHeadline } = require('./transcript')
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
  let hookInput
  try {
    hookInput = JSON.parse(input)
  } catch {
    return
  }

  // Find git root
  const root = gitRoot()
  if (!root) return

  // Check project config
  const config = loadJson(`${root}/.claude/turbocommit.json`)
  if (!config || config.enabled !== true) return

  // Don't commit during stop-hook continuations
  if (hookInput.stop_hook_active === true) return

  // Parse transcript
  const pairs = parseTranscript(hookInput.transcript_path)
  const headline = extractHeadline(pairs)
  const body = formatBody(pairs)

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
      combinedBody = priorBodies.join('\n\n---\n\n') + '\n\n---\n\n' + body
    }
  }

  addAndCommit(root, headline, combinedBody)
}

module.exports = { run }
