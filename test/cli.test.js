const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { execSync } = require('child_process')
const path = require('path')

const CLI = path.join(__dirname, '..', 'cli.js')

function cli (args, opts = {}) {
  try {
    return {
      stdout: execSync(`node ${CLI} ${args}`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...opts
      }).trim(),
      exitCode: 0
    }
  } catch (err) {
    return {
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || '').trim(),
      exitCode: err.status
    }
  }
}

describe('cli', () => {
  it('shows help by default', () => {
    const result = cli('')
    assert.ok(result.stdout.includes('turbocommit'))
    assert.ok(result.stdout.includes('Commands:'))
  })

  it('shows help with --help', () => {
    const result = cli('--help')
    assert.ok(result.stdout.includes('Commands:'))
  })

  it('shows help with help command', () => {
    const result = cli('help')
    assert.ok(result.stdout.includes('Commands:'))
  })

  it('shows version with --version', () => {
    const result = cli('--version')
    const pkg = require('../package.json')
    assert.equal(result.stdout, pkg.version)
  })

  it('shows version with -v', () => {
    const result = cli('-v')
    const pkg = require('../package.json')
    assert.equal(result.stdout, pkg.version)
  })

  it('reports unknown command', () => {
    const result = cli('bogus')
    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes('Unknown command'))
  })

  it('run command outputs block JSON for outdated hooks', () => {
    const result = cli('run', { input: '{}' })
    assert.equal(result.exitCode, 0)
    const output = JSON.parse(result.stdout)
    assert.equal(output.decision, 'block')
    assert.ok(output.reason.includes('outdated'))
    assert.ok(output.reason.includes('turbocommit install'))
  })

  it('run command exits cleanly when stop_hook_active is true', () => {
    const result = cli('run', { input: JSON.stringify({ stop_hook_active: true }) })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, '')
  })

  it('hook subcommand with unknown event does not crash', () => {
    const result = cli('hook unknown', { input: '{}' })
    assert.equal(result.exitCode, 0)
  })

  it('help text mentions hook command', () => {
    const result = cli('help')
    assert.ok(result.stdout.includes('hook'))
  })
})
