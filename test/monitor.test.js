const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { formatEntry, readEntries, formatSize, formatTime } = require('../lib/monitor')

describe('formatSize', () => {
  it('formats bytes below 1024', () => {
    assert.equal(formatSize(500), '500B')
  })

  it('formats kilobytes', () => {
    assert.equal(formatSize(45000), '44KB')
  })

  it('formats zero', () => {
    assert.equal(formatSize(0), '0B')
  })
})

describe('formatTime', () => {
  it('returns HH:MM:SS format', () => {
    const result = formatTime(Date.now())
    assert.match(result, /^\d{2}:\d{2}:\d{2}$/)
  })
})

describe('formatEntry', () => {
  it('formats a start entry with cyan', () => {
    const entry = { event: 'start', project: 'turbocommit', branch: 'main', context: 45000, at: Date.now() }
    const line = formatEntry(entry, 100)
    assert.ok(line.includes('start'))
    assert.ok(line.includes('turbocommit'))
    assert.ok(line.includes('main'))
    assert.ok(line.includes('44KB'))
    assert.ok(line.includes('\x1b[36m')) // cyan
  })

  it('formats a success entry with green and title', () => {
    const entry = { event: 'success', project: 'app', branch: 'dev', context: 1024, title: 'Add feature', at: Date.now() }
    const line = formatEntry(entry, 100)
    assert.ok(line.includes('success'))
    assert.ok(line.includes('Add feature'))
    assert.ok(line.includes('\x1b[32m')) // green
  })

  it('formats a fail entry with red', () => {
    const entry = { event: 'fail', project: 'app', branch: 'main', context: 0, at: Date.now() }
    const line = formatEntry(entry, 80)
    assert.ok(line.includes('fail'))
    assert.ok(line.includes('\x1b[31m')) // red
  })

  it('truncates long titles to fit terminal width', () => {
    const entry = { event: 'success', project: 'p', branch: 'b', context: 0, title: 'A'.repeat(200), at: Date.now() }
    const line = formatEntry(entry, 80)
    // Should contain ellipsis character
    assert.ok(line.includes('\u2026'))
  })

  it('handles missing title', () => {
    const entry = { event: 'start', project: 'p', branch: 'b', context: 0, at: Date.now() }
    const line = formatEntry(entry, 80)
    assert.ok(typeof line === 'string')
  })
})

describe('readEntries', () => {
  it('parses valid JSONL file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mon-'))
    const file = path.join(dir, 'test.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ event: 'start', project: 'a', branch: 'b', context: 0, at: 1 }),
      JSON.stringify({ event: 'success', project: 'a', branch: 'b', context: 0, title: 'x', at: 2 })
    ].join('\n') + '\n')
    const entries = readEntries(file)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].event, 'start')
    assert.equal(entries[1].event, 'success')
  })

  it('returns empty array for missing file', () => {
    assert.deepEqual(readEntries('/nonexistent/file.jsonl'), [])
  })

  it('skips invalid JSON lines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-mon-'))
    const file = path.join(dir, 'test.jsonl')
    fs.writeFileSync(file, 'not json\n' + JSON.stringify({ event: 'fail', at: 1 }) + '\n')
    const entries = readEntries(file)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].event, 'fail')
  })
})
