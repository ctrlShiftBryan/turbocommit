const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { logEvent, logPath } = require('../lib/log')

describe('logEvent', () => {
  let realHome

  before(() => { realHome = process.env.HOME })
  beforeEach(() => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-log-'))
  })
  after(() => { process.env.HOME = realHome })

  it('writes valid JSONL with all fields', () => {
    logEvent('start', { project: 'myapp', branch: 'main', context: 45000 })
    const lp = logPath()
    const lines = fs.readFileSync(lp, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
    const entry = JSON.parse(lines[0])
    assert.equal(entry.event, 'start')
    assert.equal(entry.project, 'myapp')
    assert.equal(entry.branch, 'main')
    assert.equal(entry.context, 45000)
    assert.equal(entry.title, null)
    assert.equal(typeof entry.at, 'number')
  })

  it('includes title on success', () => {
    logEvent('success', { project: 'app', branch: 'dev', context: 100, title: 'Add feature' })
    const entry = JSON.parse(fs.readFileSync(logPath(), 'utf8').trim())
    assert.equal(entry.title, 'Add feature')
  })

  it('appends multiple entries', () => {
    logEvent('start', { project: 'a', branch: 'b', context: 0 })
    logEvent('success', { project: 'a', branch: 'b', context: 0, title: 'Done' })
    logEvent('fail', { project: 'a', branch: 'b', context: 0 })
    const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    assert.equal(JSON.parse(lines[0]).event, 'start')
    assert.equal(JSON.parse(lines[1]).event, 'success')
    assert.equal(JSON.parse(lines[2]).event, 'fail')
  })

  it('creates directory if missing', () => {
    const lp = logPath()
    const dir = path.dirname(lp)
    fs.rmSync(dir, { recursive: true, force: true })
    logEvent('start', { project: 'x', branch: 'y', context: 0 })
    assert.ok(fs.existsSync(lp))
  })

  it('silently swallows errors (best-effort)', () => {
    // Point HOME at a read-only directory so appendFileSync fails
    const roDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-log-ro-'))
    const tcDir = path.join(roDir, '.claude', 'turbocommit')
    fs.mkdirSync(tcDir, { recursive: true })
    fs.chmodSync(tcDir, 0o444)
    process.env.HOME = roDir
    // Should not throw
    logEvent('start', { project: 'x', branch: 'y', context: 0 })
    // Restore permissions for cleanup
    fs.chmodSync(tcDir, 0o755)
  })
})
