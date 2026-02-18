const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { run } = require('../lib/run')

function makeRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-run-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  return dir
}

function enableAndCommit (dir) {
  const claudeDir = path.join(dir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })
  fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({ enabled: true }))
  fs.writeFileSync(path.join(dir, 'README.md'), 'init')
  execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })
}

function makeTranscript (pairs) {
  // Write transcript outside the repo to avoid untracked-file noise
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
  const file = path.join(dir, 'transcript.jsonl')
  const lines = []
  for (const { prompt, response } of pairs) {
    lines.push(JSON.stringify({ type: 'user', message: { content: prompt } }))
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: response }] }
    }))
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function commitCount (dir) {
  return Number(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim())
}

function lastSubject (dir) {
  return execSync('git log --format=%s -1', { cwd: dir, encoding: 'utf8' }).trim()
}

function lastBody (dir) {
  return execSync('git log --format=%b -1', { cwd: dir, encoding: 'utf8' }).trim()
}

function withCwd (dir, fn) {
  const oldCwd = process.cwd()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(oldCwd)
  }
}

describe('run', () => {
  it('does nothing without config', () => {
    const dir = makeRepo()
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: '' }))
    })
  })

  it('does nothing when enabled is false', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir)
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({ enabled: false }))
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: '' }))
    })
    const log = execSync('git log --oneline 2>&1 || echo "no commits"', { cwd: dir, encoding: 'utf8' })
    assert.ok(log.includes('no commits') || log.includes('does not have any commits'))
  })

  it('bails on stop_hook_active', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    withCwd(dir, () => {
      run(JSON.stringify({ stop_hook_active: true, transcript_path: '' }))
    })
    // Should still be just the initial commit
    assert.equal(commitCount(dir), 1)
  })

  it('creates empty commit with 🫥 marker when no changes', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi there' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(lastSubject(dir), 'Hello 🫥')
    assert.ok(lastBody(dir).includes('Prompt:'))
  })

  it('creates normal commit with file changes', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'new content')
    const transcript = makeTranscript([{ prompt: 'Add a file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(lastSubject(dir), 'Add a file')
    assert.ok(!lastSubject(dir).includes('🫥'))
  })

  it('squashes contiguous 🫥 commits when real changes arrive', () => {
    const dir = makeRepo()
    enableAndCommit(dir)

    withCwd(dir, () => {
      // Two turns with no file changes → two 🫥 commits
      const t1 = makeTranscript([{ prompt: 'Turn 1', response: 'Thinking...' }])
      run(JSON.stringify({ transcript_path: t1 }))

      const t2 = makeTranscript([{ prompt: 'Turn 2', response: 'Still thinking...' }])
      run(JSON.stringify({ transcript_path: t2 }))

      assert.equal(commitCount(dir), 3) // Initial + 2 empty

      // Now make real changes
      fs.writeFileSync(path.join(dir, 'result.txt'), 'done')
      const t3 = makeTranscript([{ prompt: 'Turn 3 with changes', response: 'Created file.' }])
      run(JSON.stringify({ transcript_path: t3 }))
    })

    // Should have squashed: Initial + 1 combined commit
    assert.equal(commitCount(dir), 2)
    assert.equal(lastSubject(dir), 'Turn 3 with changes')
    const body = lastBody(dir)
    assert.ok(body.includes('Turn 1'))
    assert.ok(body.includes('Turn 2'))
    assert.ok(body.includes('Turn 3'))
  })

  it('handles invalid JSON input gracefully', () => {
    run('not json')
  })

  it('handles first commit in empty repo', () => {
    const dir = makeRepo()
    // Enable turbocommit without committing (empty repo)
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({ enabled: true }))
    fs.writeFileSync(path.join(dir, 'file.txt'), 'first file')

    const transcript = makeTranscript([{ prompt: 'Init project', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(commitCount(dir), 1)
    assert.equal(lastSubject(dir), 'Init project')
  })
})
