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
})
