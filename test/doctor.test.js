const { describe, it } = require('node:test')
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

describe('doctor', () => {
  it('all ok when hook is installed and last, local config enabled', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'other-tool' },
            { type: 'command', command: 'turbocommit run' }
          ]
        }]
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

  it('warns when hook is not last in its group', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'turbocommit run' },
            { type: 'command', command: 'after-turbocommit' }
          ]
        }]
      }
    })

    const result = doctor(settings, repo)
    const lastCheck = result.checks.find(c => c.name === 'Last hook in Stop')
    assert.equal(lastCheck.status, 'warn')
    assert.ok(lastCheck.message.includes('not the last hook'))
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
    const lastCheck = result.checks.find(c => c.name === 'Last hook in Stop')
    assert.equal(lastCheck.status, 'warn')
    assert.ok(lastCheck.message.includes('Another group'))
  })

  it('warns about grouping opportunity when sole hook in own group', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: true })
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
    const groupCheck = result.checks.find(c => c.name === 'Grouping opportunity')
    assert.ok(groupCheck, 'expected grouping opportunity check')
    assert.equal(groupCheck.status, 'warn')
    assert.ok(groupCheck.message.includes('could be combined'))
  })

  it('does not warn about grouping when turbocommit shares a group', () => {
    const repo = makeRepo()
    writeLocalConfig(repo, { enabled: true })
    const settings = tmpSettings({
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'other-hook' },
            { type: 'command', command: 'turbocommit run' }
          ]
        }]
      }
    })

    const result = doctor(settings, repo)
    const groupCheck = result.checks.find(c => c.name === 'Grouping opportunity')
    assert.equal(groupCheck, undefined)
  })

  it('warns when local config missing', () => {
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

  it('warns when enabled is false', () => {
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
