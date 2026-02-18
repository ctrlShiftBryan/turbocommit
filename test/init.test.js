const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { init, deinit } = require('../lib/init')

function makeRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-init-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  return dir
}

describe('init', () => {
  it('creates .claude/turbocommit.json', () => {
    const dir = makeRepo()
    const result = init(dir)
    assert.equal(result.ok, true)
    assert.equal(result.alreadyExists, false)
    const config = JSON.parse(fs.readFileSync(result.path, 'utf8'))
    assert.equal(config.enabled, true)
  })

  it('reports already exists on second call', () => {
    const dir = makeRepo()
    init(dir)
    const result = init(dir)
    assert.equal(result.ok, true)
    assert.equal(result.alreadyExists, true)
  })

  it('fails outside a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nogit-'))
    const result = init(dir)
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('git'))
  })
})

describe('deinit', () => {
  it('removes the config file', () => {
    const dir = makeRepo()
    const initResult = init(dir)
    assert.ok(fs.existsSync(initResult.path))
    const result = deinit(dir)
    assert.equal(result.ok, true)
    assert.equal(result.existed, true)
    assert.ok(!fs.existsSync(initResult.path))
  })

  it('reports not existed when file missing', () => {
    const dir = makeRepo()
    const result = deinit(dir)
    assert.equal(result.ok, true)
    assert.equal(result.existed, false)
  })

  it('fails outside a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nogit-'))
    const result = deinit(dir)
    assert.equal(result.ok, false)
  })
})
