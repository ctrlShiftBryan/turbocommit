const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { run, formatModelName, resolveCoauthor } = require('../lib/run')

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
  fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
    enabled: true,
    title: { type: 'transcript' }
  }))
  fs.writeFileSync(path.join(dir, 'README.md'), 'init')
  execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })
}

function makeTranscript (pairs, { model } = {}) {
  // Write transcript outside the repo to avoid untracked-file noise
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
  const file = path.join(dir, 'transcript.jsonl')
  const lines = []
  for (const { prompt, response } of pairs) {
    lines.push(JSON.stringify({ type: 'user', message: { content: prompt } }))
    const msg = { content: [{ type: 'text', text: response }] }
    if (model) msg.model = model
    lines.push(JSON.stringify({ type: 'assistant', message: msg }))
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
  let realHome
  before(() => {
    realHome = process.env.HOME
  })
  // Each test gets a fresh HOME so global config never leaks between tests
  beforeEach(() => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-home-'))
  })
  after(() => {
    process.env.HOME = realHome
  })
  it('does nothing when TURBOCOMMIT_DISABLED is set', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi' }])
    process.env.TURBOCOMMIT_DISABLED = '1'
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript }))
      })
      assert.equal(commitCount(dir), 1) // only the initial commit
    } finally {
      delete process.env.TURBOCOMMIT_DISABLED
    }
  })

  it('disables when TURBOCOMMIT_DISABLED is "0" (truthy string)', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi' }])
    process.env.TURBOCOMMIT_DISABLED = '0'
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript }))
      })
      assert.equal(commitCount(dir), 1)
    } finally {
      delete process.env.TURBOCOMMIT_DISABLED
    }
  })

  it('runs normally when TURBOCOMMIT_DISABLED is empty string', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi' }])
    process.env.TURBOCOMMIT_DISABLED = ''
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript }))
      })
      assert.equal(commitCount(dir), 2) // initial + new commit
    } finally {
      delete process.env.TURBOCOMMIT_DISABLED
    }
  })

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

      assert.equal(commitCount(dir), 2) // Initial + 1 combined empty

      // Now make real changes
      fs.writeFileSync(path.join(dir, 'result.txt'), 'done')
      const t3 = makeTranscript([{ prompt: 'Turn 3 with changes', response: 'Created file.' }])
      run(JSON.stringify({ transcript_path: t3 }))
    })

    // Should have squashed: Initial + 1 combined commit
    assert.equal(commitCount(dir), 2)
    assert.equal(lastSubject(dir), 'Turn 3 with changes')
    const body = lastBody(dir)
    assert.ok(body.includes('## Planning'))
    assert.ok(body.includes('## Implementation'))
    assert.ok(body.includes('Turn 1'))
    assert.ok(body.includes('Turn 2'))
    assert.ok(body.includes('Turn 3'))
    // Planning section comes before Implementation
    assert.ok(body.indexOf('## Planning') < body.indexOf('## Implementation'))
  })

  it('squashes contiguous 🫥 commits on consecutive empty turns', () => {
    const dir = makeRepo()
    enableAndCommit(dir)

    withCwd(dir, () => {
      const t1 = makeTranscript([{ prompt: 'Turn 1', response: 'Thinking...' }])
      run(JSON.stringify({ transcript_path: t1 }))
      assert.equal(commitCount(dir), 2) // Initial + 1 empty

      const t2 = makeTranscript([{ prompt: 'Turn 2', response: 'Still thinking...' }])
      run(JSON.stringify({ transcript_path: t2 }))
      assert.equal(commitCount(dir), 2) // Squashed into 1 empty

      const t3 = makeTranscript([{ prompt: 'Turn 3', response: 'More thinking...' }])
      run(JSON.stringify({ transcript_path: t3 }))
      assert.equal(commitCount(dir), 2) // Still squashed
    })

    const body = lastBody(dir)
    assert.ok(body.includes('Turn 1'))
    assert.ok(body.includes('Turn 2'))
    assert.ok(body.includes('Turn 3'))
    assert.ok(!body.includes('## Planning'), 'no-changes squash must not use Planning/Implementation headers')
    assert.ok(!body.includes('## Implementation'), 'no-changes squash must not use Planning/Implementation headers')
  })

  it('handles invalid JSON input gracefully', () => {
    run('not json')
  })

  it('handles first commit in empty repo', () => {
    const dir = makeRepo()
    // Enable turbocommit without committing (empty repo)
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'transcript' }
    }))
    fs.writeFileSync(path.join(dir, 'file.txt'), 'first file')

    const transcript = makeTranscript([{ prompt: 'Init project', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(commitCount(dir), 1)
    assert.equal(lastSubject(dir), 'Init project')
  })

  it('uses agent for headline by default when title.type is absent', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { command: 'echo "Agent default headline"' }
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Original prompt', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(lastSubject(dir), 'Agent default headline')
  })

  it('uses transcript headline when title.type is "transcript"', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'transcript' }
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Transcript headline', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(lastSubject(dir), 'Transcript headline')
  })

  it('uses agent output for headline when title.type is "agent"', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'agent', command: 'echo "Agent headline"' }
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Original prompt', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(lastSubject(dir), 'Agent headline')
  })

  it('uses agent output for body when body.type is "agent"', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'transcript' },
      body: { type: 'agent', command: 'echo "Agent body text"' }
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Add file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(lastBody(dir), 'Agent body text')
  })

  it('falls back to transcript when agent fails', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'agent', command: 'exit 1' },
      body: { type: 'agent', command: 'exit 1' }
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Fallback headline', response: 'Fallback response.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    // Falls back to transcript-based headline
    assert.equal(lastSubject(dir), 'Fallback headline')
    // Falls back to transcript-based body
    assert.ok(lastBody(dir).includes('Prompt:'))
    assert.ok(lastBody(dir).includes('Fallback headline'))
  })

  it('merges global and project config', () => {
    const dir = makeRepo()

    // Set up global config with title agent (HOME is already isolated)
    const globalDir = path.join(process.env.HOME, '.claude')
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'agent', command: 'echo "Global title"' }
    }))

    // Project config overrides just the command
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      title: { command: 'echo "Project title"' }
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Ignored', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    // Project command wins, but type from global is preserved via merge
    assert.equal(lastSubject(dir), 'Project title')
  })

  it('commits when only global config has enabled: true', () => {
    const dir = makeRepo()

    // Global config enables turbocommit (HOME is isolated)
    const globalDir = path.join(process.env.HOME, '.claude')
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'transcript' }
    }))

    // No project config at all
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Global only', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(commitCount(dir), 2)
    assert.equal(lastSubject(dir), 'Global only')
  })

  it('project enabled: false overrides global enabled: true', () => {
    const dir = makeRepo()

    // Global config enables turbocommit
    const globalDir = path.join(process.env.HOME, '.claude')
    fs.mkdirSync(globalDir, { recursive: true })
    fs.writeFileSync(path.join(globalDir, 'turbocommit.json'), JSON.stringify({
      enabled: true
    }))

    // Project config explicitly disables
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: false
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Should not commit', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    // Should still be just the initial commit — project disabled wins
    assert.equal(commitCount(dir), 1)
  })

  it('preserves $$ in transcript through agent pipeline', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { type: 'transcript' },
      body: { type: 'agent', command: 'cat', prompt: '{{transcript}}' }
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'I used $$ for regex', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    // The $$ must survive through renderPrompt without being collapsed to $
    const body = lastBody(dir)
    assert.ok(body.includes('$$'), `expected $$ in body but got: ${body}`)
  })

  it('appends coauthor trailer when CLAUDECODE set and model present', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript(
      [{ prompt: 'Add file', response: 'Done.' }],
      { model: 'claude-opus-4-6' }
    )
    const oldClaudeCode = process.env.CLAUDECODE
    process.env.CLAUDECODE = '1'
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript }))
      })
      const body = lastBody(dir)
      assert.ok(body.includes('Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'))
    } finally {
      if (oldClaudeCode === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = oldClaudeCode
    }
  })

  it('skips coauthor when CLAUDECODE is not set', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript(
      [{ prompt: 'Add file', response: 'Done.' }],
      { model: 'claude-opus-4-6' }
    )
    const oldClaudeCode = process.env.CLAUDECODE
    delete process.env.CLAUDECODE
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript }))
      })
      const body = lastBody(dir)
      assert.ok(!body.includes('Co-Authored-By'))
    } finally {
      if (oldClaudeCode !== undefined) process.env.CLAUDECODE = oldClaudeCode
    }
  })

  it('skips coauthor when model is missing from transcript', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Add file', response: 'Done.' }])
    const oldClaudeCode = process.env.CLAUDECODE
    process.env.CLAUDECODE = '1'
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript }))
      })
      const body = lastBody(dir)
      assert.ok(!body.includes('Co-Authored-By'))
    } finally {
      if (oldClaudeCode === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = oldClaudeCode
    }
  })

  it('skips coauthor when config.coauthor is false', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true, title: { type: 'transcript' }, coauthor: false
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript(
      [{ prompt: 'Add file', response: 'Done.' }],
      { model: 'claude-opus-4-6' }
    )
    const oldClaudeCode = process.env.CLAUDECODE
    process.env.CLAUDECODE = '1'
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript }))
      })
      const body = lastBody(dir)
      assert.ok(!body.includes('Co-Authored-By'))
    } finally {
      if (oldClaudeCode === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = oldClaudeCode
    }
  })

  it('uses custom coauthor string from config', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true, title: { type: 'transcript' }, coauthor: 'My Bot <bot@example.com>'
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Add file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    const body = lastBody(dir)
    assert.ok(body.includes('Co-Authored-By: My Bot <bot@example.com>'))
  })

  it('auto-detects coauthor when config.coauthor is explicit true', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true, title: { type: 'transcript' }, coauthor: true
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript(
      [{ prompt: 'Add file', response: 'Done.' }],
      { model: 'claude-sonnet-4-6' }
    )
    const oldClaudeCode = process.env.CLAUDECODE
    process.env.CLAUDECODE = '1'
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript }))
      })
      const body = lastBody(dir)
      assert.ok(body.includes('Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>'))
    } finally {
      if (oldClaudeCode === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = oldClaudeCode
    }
  })

  it('appends coauthor after squashed Planning/Implementation body', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const oldClaudeCode = process.env.CLAUDECODE
    process.env.CLAUDECODE = '1'
    try {
      withCwd(dir, () => {
        // Empty turn → 🫥 commit
        const t1 = makeTranscript(
          [{ prompt: 'Turn 1', response: 'Thinking...' }],
          { model: 'claude-opus-4-6' }
        )
        run(JSON.stringify({ transcript_path: t1 }))

        // Real changes arrive — squash the 🫥
        fs.writeFileSync(path.join(dir, 'result.txt'), 'done')
        const t2 = makeTranscript(
          [{ prompt: 'Turn 2 with changes', response: 'Created file.' }],
          { model: 'claude-opus-4-6' }
        )
        run(JSON.stringify({ transcript_path: t2 }))
      })

      const body = lastBody(dir)
      assert.ok(body.includes('## Planning'))
      assert.ok(body.includes('## Implementation'))
      assert.ok(body.includes('Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'))
      // Trailer must be after all content
      const coauthorIdx = body.indexOf('Co-Authored-By:')
      const implIdx = body.indexOf('## Implementation')
      assert.ok(coauthorIdx > implIdx, 'coauthor trailer should come after Implementation section')
    } finally {
      if (oldClaudeCode === undefined) delete process.env.CLAUDECODE
      else process.env.CLAUDECODE = oldClaudeCode
    }
  })
})

describe('formatModelName', () => {
  it('formats claude-opus-4-6', () => {
    assert.equal(formatModelName('claude-opus-4-6'), 'Claude Opus 4.6')
  })

  it('formats claude-sonnet-4-6', () => {
    assert.equal(formatModelName('claude-sonnet-4-6'), 'Claude Sonnet 4.6')
  })

  it('formats claude-haiku-4-5-20251001 (strips date)', () => {
    assert.equal(formatModelName('claude-haiku-4-5-20251001'), 'Claude Haiku 4.5')
  })

  it('formats old-style claude-3-5-sonnet-20241022', () => {
    assert.equal(formatModelName('claude-3-5-sonnet-20241022'), 'Claude Sonnet 3.5')
  })

  it('formats old-style claude-3-opus-20240229', () => {
    assert.equal(formatModelName('claude-3-opus-20240229'), 'Claude Opus 3')
  })

  it('formats old-style claude-3-5-haiku-20241022', () => {
    assert.equal(formatModelName('claude-3-5-haiku-20241022'), 'Claude Haiku 3.5')
  })

  it('returns raw ID for non-claude models', () => {
    assert.equal(formatModelName('gpt-4'), 'gpt-4')
  })

  it('returns null for null input', () => {
    assert.equal(formatModelName(null), null)
  })

  it('returns null for undefined input', () => {
    assert.equal(formatModelName(undefined), null)
  })
})

describe('resolveCoauthor', () => {
  it('returns null when coauthor is false', () => {
    assert.equal(resolveCoauthor({ coauthor: false }, '/some/path'), null)
  })

  it('wraps custom string in Co-Authored-By header', () => {
    assert.equal(
      resolveCoauthor({ coauthor: 'Bot <b@x.com>' }, '/any'),
      'Co-Authored-By: Bot <b@x.com>'
    )
  })

  it('returns null when CLAUDECODE is not set (auto-detect)', () => {
    const old = process.env.CLAUDECODE
    delete process.env.CLAUDECODE
    try {
      assert.equal(resolveCoauthor({}, '/some/path'), null)
    } finally {
      if (old !== undefined) process.env.CLAUDECODE = old
    }
  })
})
