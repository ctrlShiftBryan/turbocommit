const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { mergeConfig, tryRun } = require('../lib/io')

describe('tryRun', () => {
  it('returns stdout and code 0 on success', () => {
    const r = tryRun('echo hello', {})
    assert.equal(r.code, 0)
    assert.equal(r.stdout.trim(), 'hello')
  })

  it('returns code 1 on non-zero exit', () => {
    const r = tryRun('exit 1', {})
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
  })

  it('returns failure result when spawnSync throws', () => {
    // cwd pointing to a non-existent directory causes spawnSync to throw ENOENT
    const r = tryRun('echo hello', { cwd: '/no/such/dir/that/exists' })
    assert.equal(r.code, 1)
    assert.equal(r.stdout, '')
  })
})

describe('mergeConfig', () => {
  it('returns project when global is empty', () => {
    assert.deepStrictEqual(
      mergeConfig({}, { enabled: true }),
      { enabled: true }
    )
  })

  it('returns global when project is empty', () => {
    assert.deepStrictEqual(
      mergeConfig({ enabled: true }, {}),
      { enabled: true }
    )
  })

  it('returns empty object when both are empty', () => {
    assert.deepStrictEqual(mergeConfig({}, {}), {})
  })

  it('project scalar overrides global scalar', () => {
    assert.deepStrictEqual(
      mergeConfig({ enabled: true }, { enabled: false }),
      { enabled: false }
    )
  })

  it('deep-merges nested objects', () => {
    const result = mergeConfig(
      { title: { type: 'agent', command: 'claude -p' } },
      { title: { command: 'echo hi' } }
    )
    assert.deepStrictEqual(result, {
      title: { type: 'agent', command: 'echo hi' }
    })
  })

  it('project object replaces global scalar', () => {
    const result = mergeConfig(
      { title: 'simple' },
      { title: { type: 'agent' } }
    )
    assert.deepStrictEqual(result, { title: { type: 'agent' } })
  })

  it('project scalar replaces global object', () => {
    const result = mergeConfig(
      { title: { type: 'agent' } },
      { title: 'off' }
    )
    assert.deepStrictEqual(result, { title: 'off' })
  })

  it('project array replaces global array (no merge)', () => {
    const result = mergeConfig(
      { tags: ['a', 'b'] },
      { tags: ['c'] }
    )
    assert.deepStrictEqual(result, { tags: ['c'] })
  })

  it('project array replaces global object', () => {
    const result = mergeConfig(
      { title: { type: 'agent' } },
      { title: ['a'] }
    )
    assert.deepStrictEqual(result, { title: ['a'] })
  })

  it('handles null values in project', () => {
    const result = mergeConfig(
      { title: { type: 'agent' } },
      { title: null }
    )
    assert.deepStrictEqual(result, { title: null })
  })

  it('handles null values in global', () => {
    const result = mergeConfig(
      { title: null },
      { title: { type: 'agent' } }
    )
    assert.deepStrictEqual(result, { title: { type: 'agent' } })
  })

  it('preserves keys unique to global', () => {
    const result = mergeConfig(
      { enabled: true, title: { type: 'agent' } },
      { body: { type: 'agent' } }
    )
    assert.deepStrictEqual(result, {
      enabled: true,
      title: { type: 'agent' },
      body: { type: 'agent' }
    })
  })

  it('merges multiple nested objects independently', () => {
    const result = mergeConfig(
      { title: { type: 'agent', command: 'claude -p' }, body: { type: 'agent', command: 'claude -p' } },
      { title: { prompt: 'custom' }, body: { command: 'echo hi' } }
    )
    assert.deepStrictEqual(result, {
      title: { type: 'agent', command: 'claude -p', prompt: 'custom' },
      body: { type: 'agent', command: 'echo hi' }
    })
  })
})
