const fs = require('fs')
const path = require('path')
const { ensureDir } = require('./io')

const BREADCRUMB_THRESHOLD_MS = 2000
const STALE_TTL_MS = 24 * 60 * 60 * 1000

function turbocommitDir (root) {
  const { gitDir } = require('./git')
  const dir = gitDir(root)
  return path.join(dir || path.join(root, '.git'), 'turbocommit')
}

function breadcrumbDir (root) {
  return path.join(turbocommitDir(root), 'breadcrumbs')
}

function chainDir (root) {
  return path.join(turbocommitDir(root), 'chains')
}

function pendingDir (root) {
  return path.join(turbocommitDir(root), 'pending')
}

function watermarkDir (root) {
  return path.join(turbocommitDir(root), 'watermarks')
}

function refineDir (root) {
  return path.join(turbocommitDir(root), 'refine')
}

function saveRefineManifest (root, sha, data) {
  const dir = refineDir(root)
  ensureDir(dir)
  fs.writeFileSync(path.join(dir, sha + '.json'), JSON.stringify(data) + '\n')
  return path.join(dir, sha + '.json')
}

function readRefineManifest (manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

function cleanupRefineManifest (manifestPath) {
  try {
    fs.unlinkSync(manifestPath)
  } catch {}
}

/**
 * SessionEnd handler. Writes a breadcrumb for the ending session.
 */
function handleSessionEnd (input, root) {
  if (!root) return

  let hookInput
  try {
    hookInput = JSON.parse(input)
  } catch {
    return
  }

  const sessionId = hookInput.session_id
  if (!sessionId) return

  const dir = breadcrumbDir(root)
  ensureDir(dir)
  const data = { session_id: sessionId, timestamp: Date.now() }
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify(data) + '\n')
}

/**
 * SessionStart handler. Matches breadcrumbs for /clear and resume continuations.
 */
function handleSessionStart (input, root) {
  if (!root) return

  let hookInput
  try {
    hookInput = JSON.parse(input)
  } catch {
    return
  }

  const sessionId = hookInput.session_id
  if (!sessionId) return

  const source = hookInput.source
  if (source !== 'clear' && source !== 'resume') return

  const dir = breadcrumbDir(root)
  if (!fs.existsSync(dir)) return

  // Scan breadcrumbs for closest match
  const now = Date.now()
  let best = null
  let bestGap = Infinity

  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return
  }

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      const gap = Math.abs(now - data.timestamp)
      if (gap < bestGap) {
        bestGap = gap
        best = data
      }
    } catch {
      continue
    }
  }

  if (!best || bestGap > BREADCRUMB_THRESHOLD_MS) return

  // Claim the breadcrumb (delete it so no other session grabs it)
  try {
    fs.unlinkSync(path.join(dir, best.session_id + '.json'))
  } catch {}

  // Read predecessor's chain to get full ancestry
  const predecessorChain = readChain(root, best.session_id)
  const ancestors = [best.session_id, ...(predecessorChain ? predecessorChain.ancestors : [])]

  // Write chain for this session
  const cDir = chainDir(root)
  ensureDir(cDir)
  const chain = { parent: best.session_id, ancestors }
  fs.writeFileSync(path.join(cDir, sessionId + '.json'), JSON.stringify(chain) + '\n')
}

function readChain (root, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(chainDir(root), sessionId + '.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Get ordered ancestor list for a session (nearest first).
 */
function getAncestors (root, sessionId) {
  const chain = readChain(root, sessionId)
  return chain ? chain.ancestors : []
}

/**
 * Save formatted transcript to pending directory for later pickup.
 */
let pendingSeq = 0
function savePending (root, sessionId, transcript) {
  const dir = path.join(pendingDir(root), sessionId)
  ensureDir(dir)
  const timestamp = String(Date.now()) + '-' + String(pendingSeq++).padStart(4, '0')
  fs.writeFileSync(path.join(dir, timestamp + '.txt'), transcript)
}

/**
 * Collect pending transcripts for a list of session IDs, in order
 * (oldest ancestor first). Returns array of strings.
 */
function collectPending (root, sessionIds) {
  const results = []
  for (const sid of sessionIds) {
    const dir = path.join(pendingDir(root), sid)
    let files
    try {
      files = fs.readdirSync(dir).sort()
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.txt')) continue
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8')
        if (content.trim()) results.push(content)
      } catch {
        continue
      }
    }
  }
  return results
}

/**
 * Read watermark for a session. Returns { pairs, commit } or null.
 */
function readWatermark (root, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(watermarkDir(root), sessionId + '.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Save watermark after a commit: pair count and commit SHA.
 */
function saveWatermark (root, sessionId, pairs, commit) {
  const dir = watermarkDir(root)
  ensureDir(dir)
  fs.writeFileSync(path.join(dir, sessionId + '.json'), JSON.stringify({ pairs, commit }) + '\n')
}

/**
 * Resolve parent commit SHA for continuation references.
 * Checks own watermark first, then walks chain ancestors nearest-first.
 */
function resolveParentCommit (root, sessionId) {
  // Own watermark takes priority (same-session previous commit)
  const own = readWatermark(root, sessionId)
  if (own) return own.commit

  // Walk chain ancestors nearest-first
  const ancestors = getAncestors(root, sessionId)
  for (const aid of ancestors) {
    const wm = readWatermark(root, aid)
    if (wm) return wm.commit
  }
  return null
}

/**
 * Delete consumed pending + chain files after commit.
 */
function cleanupConsumed (root, sessionIds) {
  for (const sid of sessionIds) {
    // Remove pending dir
    const dir = path.join(pendingDir(root), sid)
    try {
      const files = fs.readdirSync(dir)
      for (const file of files) {
        fs.unlinkSync(path.join(dir, file))
      }
      fs.rmdirSync(dir)
    } catch {}

    // Chain files are preserved — resolveParentCommit needs them
    // to walk cross-session lineage. Stale cleanup handles them after 24h.
  }
}

/**
 * Remove stale orphaned files older than maxAgeMs (default 24h).
 */
function cleanupStale (root, maxAgeMs) {
  const ttl = maxAgeMs != null ? maxAgeMs : STALE_TTL_MS
  const now = Date.now()
  const base = turbocommitDir(root)

  for (const sub of ['breadcrumbs', 'chains', 'tracking', 'watermarks', 'refine']) {
    const dir = path.join(base, sub)
    let files
    try {
      files = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const file of files) {
      const fp = path.join(dir, file)
      try {
        const stat = fs.statSync(fp)
        if (now - stat.mtimeMs > ttl) {
          fs.unlinkSync(fp)
        }
      } catch {}
    }
  }

  // Clean stale pending directories
  const pDir = path.join(base, 'pending')
  let pdirs
  try {
    pdirs = fs.readdirSync(pDir)
  } catch {
    return
  }
  for (const sid of pdirs) {
    const dir = path.join(pDir, sid)
    try {
      const stat = fs.statSync(dir)
      if (!stat.isDirectory()) continue
      if (now - stat.mtimeMs > ttl) {
        const files = fs.readdirSync(dir)
        for (const file of files) {
          fs.unlinkSync(path.join(dir, file))
        }
        fs.rmdirSync(dir)
      }
    } catch {}
  }
}

module.exports = {
  handleSessionEnd,
  handleSessionStart,
  getAncestors,
  savePending,
  collectPending,
  cleanupConsumed,
  cleanupStale,
  readChain,
  readWatermark,
  saveWatermark,
  resolveParentCommit,
  saveRefineManifest,
  readRefineManifest,
  cleanupRefineManifest,
  breadcrumbDir,
  chainDir,
  pendingDir,
  watermarkDir,
  refineDir,
  turbocommitDir,
  BREADCRUMB_THRESHOLD_MS,
  STALE_TTL_MS
}
