const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const {
  handleSessionEnd,
  handleSessionStart,
  getAncestors,
  savePending,
  collectPending,
  cleanupConsumed,
  cleanupStale,
  readChain,
  breadcrumbDir,
  chainDir,
  pendingDir,
  BREADCRUMB_THRESHOLD_MS
} = require('../lib/session')

function tmpRoot () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-session-'))
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true })
  return dir
}

describe('handleSessionEnd', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('writes breadcrumb file', () => {
    handleSessionEnd(JSON.stringify({ session_id: 'A' }), root)
    const file = path.join(breadcrumbDir(root), 'A.json')
    assert.ok(fs.existsSync(file))
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(data.session_id, 'A')
    assert.equal(typeof data.timestamp, 'number')
  })

  it('does nothing without session_id', () => {
    handleSessionEnd(JSON.stringify({}), root)
    try {
      const files = fs.readdirSync(breadcrumbDir(root))
      assert.equal(files.length, 0)
    } catch {
      // Dir doesn't exist — that's fine
    }
  })

  it('does nothing with invalid JSON', () => {
    handleSessionEnd('not json', root)
    // No crash
  })

  it('does nothing without root', () => {
    handleSessionEnd(JSON.stringify({ session_id: 'A' }), null)
    // No crash
  })
})

describe('handleSessionStart', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('matches closest breadcrumb within threshold', () => {
    // Write a breadcrumb with recent timestamp
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'A.json'),
      JSON.stringify({ session_id: 'A', timestamp: Date.now() })
    )

    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'clear' }), root)

    // Breadcrumb should be claimed (deleted)
    assert.ok(!fs.existsSync(path.join(dir, 'A.json')))

    // Chain should exist
    const chain = readChain(root, 'B')
    assert.ok(chain)
    assert.equal(chain.parent, 'A')
    assert.deepEqual(chain.ancestors, ['A'])
  })

  it('ignores breadcrumbs older than threshold', () => {
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'OLD.json'),
      JSON.stringify({ session_id: 'OLD', timestamp: Date.now() - BREADCRUMB_THRESHOLD_MS - 1000 })
    )

    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'clear' }), root)

    // Breadcrumb should NOT be claimed
    assert.ok(fs.existsSync(path.join(dir, 'OLD.json')))
    // No chain should exist
    assert.equal(readChain(root, 'B'), null)
  })

  it('ignores non-clear/resume sources', () => {
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'A.json'),
      JSON.stringify({ session_id: 'A', timestamp: Date.now() })
    )

    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'startup' }), root)
    // Breadcrumb should still exist
    assert.ok(fs.existsSync(path.join(dir, 'A.json')))
  })

  it('handles resume source', () => {
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'A.json'),
      JSON.stringify({ session_id: 'A', timestamp: Date.now() })
    )

    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'resume' }), root)
    const chain = readChain(root, 'B')
    assert.ok(chain)
    assert.equal(chain.parent, 'A')
  })

  it('matches closest breadcrumb when two are within threshold', () => {
    const dir = breadcrumbDir(root)
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    // Two breadcrumbs: X ended 500ms ago, Y ended 200ms ago
    fs.writeFileSync(
      path.join(dir, 'X.json'),
      JSON.stringify({ session_id: 'X', timestamp: now - 500 })
    )
    fs.writeFileSync(
      path.join(dir, 'Y.json'),
      JSON.stringify({ session_id: 'Y', timestamp: now - 200 })
    )

    handleSessionStart(JSON.stringify({ session_id: 'Z', source: 'clear' }), root)

    // Y is closer → claimed (deleted), X remains
    assert.ok(!fs.existsSync(path.join(dir, 'Y.json')), 'closest breadcrumb (Y) should be claimed')
    assert.ok(fs.existsSync(path.join(dir, 'X.json')), 'farther breadcrumb (X) should remain')

    const chain = readChain(root, 'Z')
    assert.ok(chain)
    assert.equal(chain.parent, 'Y')
  })

  it('links chains transitively: B→A, then C→B gives ancestors [B, A]', () => {
    // Create chain A (standalone, no chain file)
    // Create breadcrumb A and start B
    const bDir = breadcrumbDir(root)
    fs.mkdirSync(bDir, { recursive: true })
    fs.writeFileSync(
      path.join(bDir, 'A.json'),
      JSON.stringify({ session_id: 'A', timestamp: Date.now() })
    )
    handleSessionStart(JSON.stringify({ session_id: 'B', source: 'clear' }), root)

    // Now end B and start C
    fs.writeFileSync(
      path.join(bDir, 'B.json'),
      JSON.stringify({ session_id: 'B', timestamp: Date.now() })
    )
    handleSessionStart(JSON.stringify({ session_id: 'C', source: 'clear' }), root)

    const chain = readChain(root, 'C')
    assert.ok(chain)
    assert.equal(chain.parent, 'B')
    assert.deepEqual(chain.ancestors, ['B', 'A'])
  })
})

describe('getAncestors', () => {
  it('returns empty array when no chain exists', () => {
    const root = tmpRoot()
    assert.deepEqual(getAncestors(root, 'X'), [])
  })

  it('returns ancestor list from chain', () => {
    const root = tmpRoot()
    const dir = chainDir(root)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'C.json'),
      JSON.stringify({ parent: 'B', ancestors: ['B', 'A'] })
    )
    assert.deepEqual(getAncestors(root, 'C'), ['B', 'A'])
  })
})

describe('savePending / collectPending', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('saves and collects pending transcript', () => {
    savePending(root, 'A', 'transcript A')
    const result = collectPending(root, ['A'])
    assert.deepEqual(result, ['transcript A'])
  })

  it('collects from multiple sessions in order', () => {
    savePending(root, 'A', 'transcript A')
    savePending(root, 'B', 'transcript B')
    // Oldest ancestor first
    const result = collectPending(root, ['A', 'B'])
    assert.deepEqual(result, ['transcript A', 'transcript B'])
  })

  it('collects multiple pending from same session in order', () => {
    savePending(root, 'A', 'turn 1')
    // Slight delay to ensure different timestamps
    savePending(root, 'A', 'turn 2')
    const result = collectPending(root, ['A'])
    assert.equal(result.length, 2)
    assert.equal(result[0], 'turn 1')
    assert.equal(result[1], 'turn 2')
  })

  it('skips sessions with no pending', () => {
    savePending(root, 'B', 'transcript B')
    const result = collectPending(root, ['A', 'B'])
    assert.deepEqual(result, ['transcript B'])
  })

  it('returns empty for no pending at all', () => {
    const result = collectPending(root, ['A', 'B'])
    assert.deepEqual(result, [])
  })
})

describe('cleanupConsumed', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('deletes pending dir and chain file', () => {
    savePending(root, 'A', 'transcript A')
    const cDir = chainDir(root)
    fs.mkdirSync(cDir, { recursive: true })
    fs.writeFileSync(path.join(cDir, 'B.json'), JSON.stringify({ parent: 'A', ancestors: ['A'] }))

    cleanupConsumed(root, ['A', 'B'])

    // Pending dir should be gone
    assert.ok(!fs.existsSync(path.join(pendingDir(root), 'A')))
    // Chain file should be gone
    assert.ok(!fs.existsSync(path.join(cDir, 'B.json')))
  })

  it('does not crash on missing files', () => {
    cleanupConsumed(root, ['X', 'Y'])
    // No crash
  })
})

describe('cleanupStale', () => {
  let root
  beforeEach(() => { root = tmpRoot() })

  it('removes files older than TTL', () => {
    const bDir = breadcrumbDir(root)
    fs.mkdirSync(bDir, { recursive: true })
    const file = path.join(bDir, 'old.json')
    fs.writeFileSync(file, '{}')
    // Set mtime to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(file, twoDaysAgo, twoDaysAgo)

    cleanupStale(root)

    assert.ok(!fs.existsSync(file))
  })

  it('preserves files within TTL', () => {
    const bDir = breadcrumbDir(root)
    fs.mkdirSync(bDir, { recursive: true })
    const file = path.join(bDir, 'recent.json')
    fs.writeFileSync(file, '{}')

    cleanupStale(root)

    assert.ok(fs.existsSync(file))
  })

  it('removes stale pending directories', () => {
    const pDir = path.join(pendingDir(root), 'stale-sess')
    fs.mkdirSync(pDir, { recursive: true })
    fs.writeFileSync(path.join(pDir, '001.txt'), 'old data')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(pDir, twoDaysAgo, twoDaysAgo)

    cleanupStale(root)

    assert.ok(!fs.existsSync(pDir))
  })

  it('does not crash when directories do not exist', () => {
    cleanupStale(root)
    // No crash
  })

  it('respects custom maxAgeMs', () => {
    const bDir = breadcrumbDir(root)
    fs.mkdirSync(bDir, { recursive: true })
    const file = path.join(bDir, 'test.json')
    fs.writeFileSync(file, '{}')
    // Set mtime to 1 second ago
    const oneSecAgo = new Date(Date.now() - 1000)
    fs.utimesSync(file, oneSecAgo, oneSecAgo)

    // With a 500ms TTL, the file should be removed
    cleanupStale(root, 500)
    assert.ok(!fs.existsSync(file))
  })
})
