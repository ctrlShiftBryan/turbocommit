const { execSync } = require('child_process')

function git (args, opts = {}) {
  const cwd = opts.cwd || process.cwd()
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trimEnd()
}

function gitRoot (cwd) {
  try {
    return git('rev-parse --show-toplevel', { cwd })
  } catch {
    return null
  }
}

function hasChanges (cwd) {
  try {
    git('diff --quiet HEAD', { cwd })
  } catch {
    return true
  }
  try {
    git('diff --cached --quiet', { cwd })
  } catch {
    return true
  }
  // Also check for untracked files
  const untracked = git('ls-files --others --exclude-standard', { cwd })
  return untracked.length > 0
}

/**
 * Count contiguous 🫥 commits from HEAD.
 */
function countEmptyMarkers (cwd) {
  let count = 0
  try {
    while (true) {
      const subject = git(`log --format=%s -1 HEAD~${count}`, { cwd })
      if (subject.endsWith('🫥')) {
        count++
      } else {
        break
      }
    }
  } catch {
    // Ran out of commits
  }
  return count
}

/**
 * Collect commit bodies from a range of commits (oldest first).
 */
function collectBodies (cwd, count) {
  const bodies = []
  for (let i = count - 1; i >= 0; i--) {
    const body = git(`log --format=%b -1 HEAD~${i}`, { cwd })
    if (body.trim()) bodies.push(body)
  }
  return bodies
}

function commitEmpty (cwd, headline, body) {
  git('add -A', { cwd })
  git(`commit --allow-empty -m "${esc(headline)} 🫥" -m "${esc(body)}" --no-verify`, { cwd })
}

function addAndCommit (cwd, headline, body) {
  git('add -A', { cwd })
  git(`commit -m "${esc(headline)}" -m "${esc(body)}" --no-verify`, { cwd })
}

function softReset (cwd, count) {
  git(`reset --soft HEAD~${count}`, { cwd })
}

function hasCommits (cwd) {
  try {
    git('rev-parse HEAD', { cwd })
    return true
  } catch {
    return false
  }
}

function esc (s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
}

module.exports = {
  git,
  gitRoot,
  hasChanges,
  countEmptyMarkers,
  collectBodies,
  commitEmpty,
  addAndCommit,
  softReset,
  hasCommits
}
