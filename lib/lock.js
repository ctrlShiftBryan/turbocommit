const fs = require('fs')
const path = require('path')
const { ensureDir } = require('./io')

const STALE_AGE_MS = 5 * 60 * 1000 // 5 minutes

function lockPath (root) {
  const { turbocommitDir } = require('./session')
  return path.join(turbocommitDir(root), 'refine.lock')
}

function isLockStale (data) {
  if (Date.now() - data.started > STALE_AGE_MS) return true
  try {
    process.kill(data.pid, 0)
    return false
  } catch {
    return true
  }
}

function readLock (root) {
  try {
    return JSON.parse(fs.readFileSync(lockPath(root), 'utf8'))
  } catch {
    return null
  }
}

function acquireLock (root, sha, timeoutMs) {
  timeoutMs = timeoutMs != null ? timeoutMs : 60000
  const lp = lockPath(root)
  const deadline = Date.now() + timeoutMs

  while (true) {
    const existing = readLock(root)
    if (existing && !isLockStale(existing)) {
      if (Date.now() >= deadline) return false
      // Poll every 2s
      const { spawnSync } = require('child_process')
      spawnSync('sleep', ['2'])
      continue
    }

    // Stale or no lock — claim it
    ensureDir(path.dirname(lp))
    fs.writeFileSync(lp, JSON.stringify({ pid: process.pid, sha, started: Date.now() }) + '\n')
    return true
  }
}

function releaseLock (root) {
  try {
    fs.unlinkSync(lockPath(root))
  } catch {}
}

module.exports = { lockPath, acquireLock, releaseLock, readLock, isLockStale, STALE_AGE_MS }
