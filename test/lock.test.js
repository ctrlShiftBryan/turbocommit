const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { acquireLock, releaseLock, readLock, isLockStale, lockPath } = require('../lib/lock')

function makeRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-lock-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  return dir
}

describe('lock', () => {
  let root

  beforeEach(() => {
    root = makeRepo()
  })

  it('acquireLock creates lock file with pid and sha', () => {
    const ok = acquireLock(root, 'abc123', 1000)
    assert.ok(ok)
    const data = readLock(root)
    assert.equal(data.pid, process.pid)
    assert.equal(data.sha, 'abc123')
    assert.ok(data.started > 0)
    releaseLock(root)
  })

  it('releaseLock removes lock file', () => {
    acquireLock(root, 'abc', 1000)
    releaseLock(root)
    assert.equal(readLock(root), null)
  })

  it('releaseLock is safe when no lock exists', () => {
    releaseLock(root) // should not throw
  })

  it('readLock returns null when no lock', () => {
    assert.equal(readLock(root), null)
  })

  it('isLockStale returns true for dead pid', () => {
    const data = { pid: 999999999, sha: 'x', started: Date.now() }
    assert.ok(isLockStale(data))
  })

  it('isLockStale returns true for old lock', () => {
    const data = { pid: process.pid, sha: 'x', started: Date.now() - 6 * 60 * 1000 }
    assert.ok(isLockStale(data))
  })

  it('isLockStale returns false for live recent lock', () => {
    const data = { pid: process.pid, sha: 'x', started: Date.now() }
    assert.ok(!isLockStale(data))
  })

  it('acquireLock replaces stale lock', () => {
    // Write a stale lock (dead PID)
    const lp = lockPath(root)
    fs.mkdirSync(path.dirname(lp), { recursive: true })
    fs.writeFileSync(lp, JSON.stringify({ pid: 999999999, sha: 'old', started: Date.now() }))

    const ok = acquireLock(root, 'new', 1000)
    assert.ok(ok)
    const data = readLock(root)
    assert.equal(data.sha, 'new')
    assert.equal(data.pid, process.pid)
    releaseLock(root)
  })

  it('acquireLock times out when locked by live process', () => {
    // Lock with current PID (alive)
    acquireLock(root, 'first', 1000)

    // Try to acquire from "another process" — but same PID, so it sees live lock
    // Use very short timeout so test doesn't hang
    const ok = acquireLock(root, 'second', 100)
    assert.ok(!ok)
    releaseLock(root)
  })
})
