const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { install, uninstall, hasTurbocommit } = require('../lib/install')

function tmpSettings (content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-'))
  const file = path.join(dir, 'settings.json')
  if (content !== undefined) {
    fs.writeFileSync(file, JSON.stringify(content, null, 2))
  }
  return file
}

describe('install', () => {
  it('creates a new group when no Stop groups exist', () => {
    const file = tmpSettings({})
    const result = install(file)
    assert.equal(result.alreadyInstalled, false)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(settings.hooks.Stop.length, 1)
    assert.equal(settings.hooks.Stop[0].hooks.length, 1)
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'turbocommit run')
  })

  it('appends to the largest existing Stop group', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'prove_it hook claude:Stop' }
          ]
        }]
      }
    })
    const result = install(file)
    assert.equal(result.alreadyInstalled, false)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    // Still one group, now with two hooks
    assert.equal(settings.hooks.Stop.length, 1)
    assert.equal(settings.hooks.Stop[0].hooks.length, 2)
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'prove_it hook claude:Stop')
    assert.equal(settings.hooks.Stop[0].hooks[1].command, 'turbocommit run')
  })

  it('picks the largest group when multiple exist', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'small' }] },
          {
            hooks: [
              { type: 'command', command: 'big-a' },
              { type: 'command', command: 'big-b' }
            ]
          }
        ]
      }
    })
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(settings.hooks.Stop.length, 2)
    // Small group unchanged
    assert.equal(settings.hooks.Stop[0].hooks.length, 1)
    // Large group got turbocommit appended
    assert.equal(settings.hooks.Stop[1].hooks.length, 3)
    assert.equal(settings.hooks.Stop[1].hooks[2].command, 'turbocommit run')
  })

  it('appends to the first group when sizes are tied', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: 'first-group' }] },
          { hooks: [{ type: 'command', command: 'second-group' }] }
        ]
      }
    })
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(settings.hooks.Stop.length, 2)
    // First group gets turbocommit (tie-break favors first)
    assert.equal(settings.hooks.Stop[0].hooks.length, 2)
    assert.equal(settings.hooks.Stop[0].hooks[1].command, 'turbocommit run')
    // Second group unchanged
    assert.equal(settings.hooks.Stop[1].hooks.length, 1)
  })

  it('creates settings file if missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-'))
    const file = path.join(dir, 'settings.json')
    const result = install(file)
    assert.equal(result.alreadyInstalled, false)
    assert.ok(fs.existsSync(file))
  })

  it('reports already installed when hook exists', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'prove_it hook claude:Stop' },
            { type: 'command', command: 'turbocommit run' }
          ]
        }]
      }
    })
    const result = install(file)
    assert.equal(result.alreadyInstalled, true)
  })

  it('is idempotent — no duplicates on re-install', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'other-tool' }] }]
      }
    })
    install(file)
    const result = install(file)
    assert.equal(result.alreadyInstalled, true)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    const tcCount = settings.hooks.Stop[0].hooks
      .filter(h => h.command && h.command.includes('turbocommit')).length
    assert.equal(tcCount, 1)
  })

  it('preserves other event hooks', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'other-tool run' }] }],
        PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prove_it hook claude:PreToolUse' }] }]
      }
    })
    install(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(settings.hooks.PreToolUse)
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'prove_it hook claude:PreToolUse')
  })
})

describe('uninstall', () => {
  it('removes turbocommit hook from within a group', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{
          hooks: [
            { type: 'command', command: 'prove_it hook claude:Stop' },
            { type: 'command', command: 'turbocommit run' }
          ]
        }]
      }
    })
    const result = uninstall(file)
    assert.equal(result.wasInstalled, true)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    // Group still exists with prove_it, turbocommit removed
    assert.equal(settings.hooks.Stop.length, 1)
    assert.equal(settings.hooks.Stop[0].hooks.length, 1)
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'prove_it hook claude:Stop')
  })

  it('removes entire group if turbocommit was the only hook', () => {
    const file = tmpSettings({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'turbocommit run' }] }]
      }
    })
    uninstall(file)
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(settings.hooks.Stop, undefined)
  })

  it('reports not installed when hook absent', () => {
    const file = tmpSettings({ hooks: {} })
    const result = uninstall(file)
    assert.equal(result.wasInstalled, false)
  })

  it('handles missing settings file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-install-'))
    const file = path.join(dir, 'settings.json')
    const result = uninstall(file)
    assert.equal(result.wasInstalled, false)
  })
})

describe('hasTurbocommit', () => {
  it('returns false for empty array', () => {
    assert.equal(hasTurbocommit([]), false)
  })

  it('returns false for null', () => {
    assert.equal(hasTurbocommit(null), false)
  })

  it('returns true when turbocommit hook exists in a group', () => {
    assert.equal(
      hasTurbocommit([{
        hooks: [
          { type: 'command', command: 'other' },
          { type: 'command', command: 'turbocommit run' }
        ]
      }]),
      true
    )
  })
})
