const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { doctor } = require('../lib/doctor')

function tmpSettings (content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doctor-'))
  const file = path.join(dir, 'settings.json')
  if (content !== undefined) {
    fs.writeFileSync(file, JSON.stringify(content, null, 2))
  }
  return file
}

function makeRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doctor-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  return dir
}

function writeLocalConfig (dir, config) {
  const claudeDir = path.join(dir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify(config, null, 2))
}

function writeGlobalConfig (config) {
  const globalDir = path.join(process.env.HOME, '.claude')
  fs.mkdirSync(globalDir, { recursive: true })
  fs.writeFileSync(path.join(globalDir, 'turbocommit.json'), JSON.stringify(config, null, 2))
}

describe('doctor', () => {
  let realHome
  before(() => {
    realHome = process.env.HOME
  })
  beforeEach(() => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-home-'))
  })
  after(() => {
    process.env.HOME = realHome
  })
  it('all ok when turbocommit is sole hook in last group', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: true })
    writeGlobalConfig({ enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'other-tool' }] },
          { hooks: [{ type: 'command', command: 'turbocommit run' }] }
        ]
      }
    })

    const result = doctor(settings, repo)
    assert.equal(result.ok, true)
    const statuses = result.checks.map(c => c.status)
    assert.ok(statuses.every(s => s === 'ok'), `expected all ok, got: ${JSON.stringify(result.checks)}`)
  })

  it('errors when settings file missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doctor-'))
    const file = path.join(dir, 'nonexistent.json')
    const result = doctor(file, dir)
    assert.equal(result.ok, false)
    assert.equal(result.checks[0].name, 'Global settings')
    assert.equal(result.checks[0].status, 'error')
  })

  it('errors when hook not installed', () => {
    const settings = tmpSettings({ hooks: {} })
    const result = doctor(settings, os.tmpdir())
    assert.equal(result.ok, false)
    const hookCheck = result.checks.find(c => c.name === 'Hook installed')
    assert.equal(hookCheck.status, 'error')
  })

  it('warns when turbocommit shares a group with other hooks', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'prove_it hook claude:Stop' },
            { type: 'command', command: 'turbocommit run' }
          ]
        }]
      }
    })

    const result = doctor(settings, repo)
    const isoCheck = result.checks.find(c => c.name === 'Group isolation')
    assert.equal(isoCheck.status, 'warn')
    assert.ok(isoCheck.message.includes('shares a group'))
  })

  it('warns when another group runs after turbocommit group', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'turbocommit run' }] },
          { hooks: [{ type: 'command', command: 'later-group-hook' }] }
        ]
      }
    })

    const result = doctor(settings, repo)
    const isoCheck = result.checks.find(c => c.name === 'Group isolation')
    assert.equal(isoCheck.status, 'warn')
    assert.ok(isoCheck.message.includes('Another group'))
  })

  it('ok when turbocommit is sole hook in last group with other groups before it', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: true })
    writeGlobalConfig({ enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: 'hook-a' },
              { type: 'command', command: 'hook-b' }
            ]
          },
          { hooks: [{ type: 'command', command: 'turbocommit run' }] }
        ]
      }
    })

    const result = doctor(settings, repo)
    const isoCheck = result.checks.find(c => c.name === 'Group isolation')
    assert.equal(isoCheck.status, 'ok')
    assert.equal(isoCheck.message, 'Sole hook in last group')
  })

  it('warns when local config missing and no global config', () => {
    const repo = makeRepo()
    const settings = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })

    const result = doctor(settings, repo)
    const localCheck = result.checks.find(c => c.name === 'Local config')
    assert.equal(localCheck.status, 'warn')
    assert.ok(localCheck.message.includes('Not found'))
  })

  it('shows info for missing local config when global config exists', () => {
    const repo = makeRepo()
    writeGlobalConfig({ enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })

    const result = doctor(settings, repo)
    const localCheck = result.checks.find(c => c.name === 'Local config')
    assert.equal(localCheck.status, 'info')
    assert.ok(localCheck.message.includes('using global config'))
  })

  it('reports enabled from global-only config', () => {
    const repo = makeRepo()
    writeGlobalConfig({ enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })

    const result = doctor(settings, repo)
    const enabledCheck = result.checks.find(c => c.name === 'Enabled')
    assert.equal(enabledCheck.status, 'ok')
    assert.equal(enabledCheck.message, 'Enabled')
  })

  it('warns when enabled is false in merged config', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: false })
    const settings = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })

    const result = doctor(settings, repo)
    const enabledCheck = result.checks.find(c => c.name === 'Enabled')
    assert.equal(enabledCheck.status, 'warn')
  })

  it('warns when neither global nor local sets enabled', () => {
    const repo = makeRepo()
    const settings = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })

    const result = doctor(settings, repo)
    const enabledCheck = result.checks.find(c => c.name === 'Enabled')
    assert.equal(enabledCheck.status, 'warn')
  })

  it('skips local checks gracefully when not in a git repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-doctor-'))
    const settings = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })

    const result = doctor(settings, dir)
    assert.equal(result.ok, true)
    const localCheck = result.checks.find(c => c.name === 'Local config')
    assert.equal(localCheck.status, 'info')
    assert.ok(localCheck.message.includes('Not in a git repo'))
  })
})
