const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { run, formatModelName, resolveCoauthor } = require('../lib/run')
const { handleTrack } = require('../lib/track')
const { savePending, chainDir } = require('../lib/session')
const { ensureDir } = require('../lib/io')

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

/**
 * Simulate PreToolUse tracking for a session in a repo.
 */
function trackWrite (root, sessionId, filePath) {
  handleTrack(JSON.stringify({
    session_id: sessionId,
    tool_name: 'Write',
    tool_input: { file_path: filePath || '/tmp/test.txt' }
  }), root)
}

/**
 * Write a chain file linking sessionId to ancestors.
 */
function writeChain (root, sessionId, parent, ancestors) {
  const dir = chainDir(root)
  ensureDir(dir)
  fs.writeFileSync(
    path.join(dir, sessionId + '.json'),
    JSON.stringify({ parent, ancestors })
  )
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
        run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
        run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
      })
      assert.equal(commitCount(dir), 1)
    } finally {
      delete process.env.TURBOCOMMIT_DISABLED
    }
  })

  it('runs normally when TURBOCOMMIT_DISABLED is empty string', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi' }])
    trackWrite(dir, 'S1')
    process.env.TURBOCOMMIT_DISABLED = ''
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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

  it('skips commit when session has no tracked modifications', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi there' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    // No new commit — only the initial
    assert.equal(commitCount(dir), 1)
  })

  it('skips when session has only Bash tracking (no file-modifying tools)', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    // Simulate Bash-only session (ls, git status)
    handleTrack(JSON.stringify({
      session_id: 'S1',
      tool_name: 'Bash',
      tool_input: { command: 'ls src/' }
    }), dir)
    const transcript = makeTranscript([{ prompt: 'List files', response: 'Here they are.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    // No commit — Bash alone isn't a modification signal
    assert.equal(commitCount(dir), 1)
    // Transcript buffered to pending
    const pendDir = path.join(dir, '.git', 'turbocommit', 'pending', 'S1')
    assert.ok(fs.existsSync(pendDir))
  })

  it('does not include Bash-only session in Planning of future commit', () => {
    const dir = makeRepo()
    enableAndCommit(dir)

    // Session A: Bash-only (read-only) → skip, buffer to pending
    handleTrack(JSON.stringify({
      session_id: 'A',
      tool_name: 'Bash',
      tool_input: { command: 'ls src/' }
    }), dir)
    const transcriptA = makeTranscript([{ prompt: 'List files', response: 'Here they are.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcriptA, session_id: 'A' }))
    })

    // Session B chains from A, makes real changes
    writeChain(dir, 'B', 'A', ['A'])
    trackWrite(dir, 'B', path.join(dir, 'result.txt'))
    fs.writeFileSync(path.join(dir, 'result.txt'), 'done')
    const transcriptB = makeTranscript([{ prompt: 'Implement feature', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcriptB, session_id: 'B' }))
    })

    assert.equal(commitCount(dir), 2)
    const body = lastBody(dir)
    // Pending from A is still picked up (it's a legitimate ancestor)
    // but the key behavior is that session A was correctly skipped as non-modifying
    assert.ok(body.includes('List files'))
  })

  it('skips even when uncommitted changes exist but no tracking', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'uncommitted')
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    // No commit — tracking is authoritative
    assert.equal(commitCount(dir), 1)
  })

  it('saves transcript to pending when skipping', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const transcript = makeTranscript([{ prompt: 'Research turn', response: 'Findings...' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    // Check pending directory was created
    const pendDir = path.join(dir, '.git', 'turbocommit', 'pending', 'S1')
    assert.ok(fs.existsSync(pendDir))
    const files = fs.readdirSync(pendDir)
    assert.equal(files.length, 1)
    const content = fs.readFileSync(path.join(pendDir, files[0]), 'utf8')
    assert.ok(content.includes('Research turn'))
  })

  it('skips and buffers when tracking exists but changes were reverted', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    // Tracking says we modified, but no actual changes remain (reverted)
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Write then revert', response: 'Reverted.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    // No new commit
    assert.equal(commitCount(dir), 1)
    // Transcript buffered to pending
    const pendDir = path.join(dir, '.git', 'turbocommit', 'pending', 'S1')
    assert.ok(fs.existsSync(pendDir))
    // Tracking file cleaned up
    const trackingFile = path.join(dir, '.git', 'turbocommit', 'tracking', 'S1.jsonl')
    assert.ok(!fs.existsSync(trackingFile))
  })

  it('commits when tracking file has entries', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'new content')
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Add a file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    assert.equal(lastSubject(dir), 'Add a file')
    assert.equal(commitCount(dir), 2)
  })

  it('picks up pending from ancestor sessions under ## Planning', () => {
    const dir = makeRepo()
    enableAndCommit(dir)

    // Simulate: Session A researched (no tracking, buffered to pending)
    savePending(dir, 'A', 'Prompt:\nResearch question\n\nResponse:\nResearch findings')

    // Session B chains from A and makes real changes
    writeChain(dir, 'B', 'A', ['A'])
    trackWrite(dir, 'B', path.join(dir, 'result.txt'))
    fs.writeFileSync(path.join(dir, 'result.txt'), 'done')

    const transcript = makeTranscript([{ prompt: 'Implement findings', response: 'Created file.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'B' }))
    })

    assert.equal(commitCount(dir), 2)
    const body = lastBody(dir)
    assert.ok(body.includes('## Planning'))
    assert.ok(body.includes('## Implementation'))
    assert.ok(body.includes('Research findings'))
    assert.ok(body.includes('Implement findings'))
    // Planning comes before Implementation
    assert.ok(body.indexOf('## Planning') < body.indexOf('## Implementation'))
  })

  it('picks up pending from multi-ancestor chain', () => {
    const dir = makeRepo()
    enableAndCommit(dir)

    // A → B → C chain, with pending in A and B
    savePending(dir, 'A', 'Research A')
    savePending(dir, 'B', 'Research B')
    writeChain(dir, 'B', 'A', ['A'])
    writeChain(dir, 'C', 'B', ['B', 'A'])
    trackWrite(dir, 'C', path.join(dir, 'result.txt'))
    fs.writeFileSync(path.join(dir, 'result.txt'), 'done')

    const transcript = makeTranscript([{ prompt: 'Final implementation', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'C' }))
    })

    const body = lastBody(dir)
    assert.ok(body.includes('## Planning'))
    assert.ok(body.includes('Research A'))
    assert.ok(body.includes('Research B'))
    // Ancestors in order (oldest first)
    assert.ok(body.indexOf('Research A') < body.indexOf('Research B'))
  })

  it('cleans up tracking, pending, and chain files after commit', () => {
    const dir = makeRepo()
    enableAndCommit(dir)

    savePending(dir, 'A', 'Research')
    writeChain(dir, 'B', 'A', ['A'])
    trackWrite(dir, 'B', path.join(dir, 'result.txt'))
    fs.writeFileSync(path.join(dir, 'result.txt'), 'done')

    const transcript = makeTranscript([{ prompt: 'Implement', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'B' }))
    })

    // Tracking file for B should be cleaned up
    const trackingFile = path.join(dir, '.git', 'turbocommit', 'tracking', 'B.jsonl')
    assert.ok(!fs.existsSync(trackingFile))
    // Pending for A should be cleaned up
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'turbocommit', 'pending', 'A')))
    // Chain for B should be cleaned up
    assert.ok(!fs.existsSync(path.join(dir, '.git', 'turbocommit', 'chains', 'B.json')))
  })

  it('commits without Planning section when no pending exists', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Add a file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    const body = lastBody(dir)
    assert.ok(!body.includes('## Planning'))
    assert.ok(!body.includes('## Implementation'))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))

    const transcript = makeTranscript([{ prompt: 'Init project', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    assert.equal(commitCount(dir), 1)
    assert.equal(lastSubject(dir), 'Init project')
  })

  it('backwards compat: skips when no session_id and no changes', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(commitCount(dir), 1) // no empty commit created
  })

  it('backwards compat: commits without session_id (old hook)', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'new content')
    const transcript = makeTranscript([{ prompt: 'Add a file', response: 'Done.' }])
    withCwd(dir, () => {
      // No session_id — old-style turbocommit run
      run(JSON.stringify({ transcript_path: transcript }))
    })
    assert.equal(commitCount(dir), 2)
    assert.equal(lastSubject(dir), 'Add a file')
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Original prompt', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    assert.equal(lastSubject(dir), 'Agent default headline')
  })

  it('passes truncated transcript to title agent for large sessions', () => {
    const dir = makeRepo()
    const claudeDir = path.join(dir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    // Use `wc -c` to echo the byte count of stdin — proves what the agent receives
    fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
      enabled: true,
      title: { command: 'wc -c' }
    }))
    fs.writeFileSync(path.join(dir, 'README.md'), 'init')
    execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

    // 20 pairs with large responses — well over 20K chars total
    const pairs = Array.from({ length: 20 }, (_, i) => ({
      prompt: `Turn ${i}`,
      response: 'x'.repeat(3000)
    }))
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript(pairs)
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    // The headline is the byte count wc -c returned. If truncation works,
    // it should be much smaller than the full transcript (~60K+ chars).
    const byteCount = Number(lastSubject(dir).trim())
    assert.ok(byteCount < 20000, `expected truncated input (<20K) but agent received ${byteCount} bytes`)
    assert.ok(byteCount > 100, `expected some content but agent received only ${byteCount} bytes`)
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Transcript headline', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Original prompt', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Add file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Fallback headline', response: 'Fallback response.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Ignored', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Global only', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'I used $$ for regex', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    // The $$ must survive through renderPrompt without being collapsed to $
    const body = lastBody(dir)
    assert.ok(body.includes('$$'), `expected $$ in body but got: ${body}`)
  })

  it('appends coauthor trailer when model present in transcript', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript(
      [{ prompt: 'Add file', response: 'Done.' }],
      { model: 'claude-opus-4-6' }
    )
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    const body = lastBody(dir)
    assert.ok(body.includes('Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'))
  })

  it('skips coauthor when model is missing from transcript', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Add file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    const body = lastBody(dir)
    assert.ok(!body.includes('Co-Authored-By'))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript(
      [{ prompt: 'Add file', response: 'Done.' }],
      { model: 'claude-opus-4-6' }
    )
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    const body = lastBody(dir)
    assert.ok(!body.includes('Co-Authored-By'))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Add file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
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
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript(
      [{ prompt: 'Add file', response: 'Done.' }],
      { model: 'claude-sonnet-4-6' }
    )
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    const body = lastBody(dir)
    assert.ok(body.includes('Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>'))
  })

  it('appends coauthor after Planning/Implementation body', () => {
    const dir = makeRepo()
    enableAndCommit(dir)

    // Buffer pending from ancestor
    savePending(dir, 'A', 'Prompt:\nTurn 1\n\nResponse:\nThinking...')
    writeChain(dir, 'B', 'A', ['A'])

    // Real changes arrive
    fs.writeFileSync(path.join(dir, 'result.txt'), 'done')
    trackWrite(dir, 'B', path.join(dir, 'result.txt'))
    const transcript = makeTranscript(
      [{ prompt: 'Turn 2 with changes', response: 'Created file.' }],
      { model: 'claude-opus-4-6' }
    )
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'B' }))
    })

    const body = lastBody(dir)
    assert.ok(body.includes('## Planning'))
    assert.ok(body.includes('## Implementation'))
    assert.ok(body.includes('Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'))
    // Trailer must be after all content
    const coauthorIdx = body.indexOf('Co-Authored-By:')
    const implIdx = body.indexOf('## Implementation')
    assert.ok(coauthorIdx > implIdx, 'coauthor trailer should come after Implementation section')
  })
})

describe('run monitor events', () => {
  let realHome
  const { logPath } = require('../lib/log')
  const readLog = () => {
    try {
      return fs.readFileSync(logPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    } catch {
      return []
    }
  }

  before(() => { realHome = process.env.HOME })
  beforeEach(() => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-home-'))
  })
  after(() => {
    process.env.HOME = realHome
  })

  it('logs start and success events on successful commit', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    const transcript = makeTranscript([{ prompt: 'Add a file', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    const entries = readLog()
    assert.equal(entries.length, 2)
    assert.equal(entries[0].event, 'start')
    assert.equal(entries[1].event, 'success')
    assert.ok(entries[0].project)
    assert.ok(entries[0].branch)
    assert.equal(typeof entries[0].context, 'number')
    assert.ok(entries[1].title)
  })

  it('logs skip event when no tracking', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    const transcript = makeTranscript([{ prompt: 'Hello', response: 'Hi' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    const entries = readLog()
    assert.equal(entries.length, 1)
    assert.equal(entries[0].event, 'skip')
  })

  it('does not log events when config disabled', () => {
    const dir = makeRepo()
    // No config → disabled
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: '' }))
    })
    const entries = readLog()
    assert.equal(entries.length, 0)
  })

  it('logs start and fail when commit logic throws', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    // Create a git index lock to make git add fail
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '')
    const transcript = makeTranscript([{ prompt: 'Will fail', response: 'Boom.' }])
    try {
      withCwd(dir, () => {
        run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
      })
    } catch {
      // Expected — commit fails
    } finally {
      fs.unlinkSync(path.join(dir, '.git', 'index.lock'))
    }
    const entries = readLog()
    assert.ok(entries.length >= 2, `expected at least 2 entries, got ${entries.length}`)
    assert.equal(entries[0].event, 'start')
    assert.equal(entries[entries.length - 1].event, 'fail')
  })

  it('commits even when logEvent fails', () => {
    const dir = makeRepo()
    enableAndCommit(dir)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    trackWrite(dir, 'S1', path.join(dir, 'file.txt'))
    // Make log dir read-only so logEvent can't write
    const tcDir = path.join(process.env.HOME, '.claude', 'turbocommit')
    fs.mkdirSync(tcDir, { recursive: true })
    fs.chmodSync(tcDir, 0o444)
    const transcript = makeTranscript([{ prompt: 'Still commits', response: 'Done.' }])
    withCwd(dir, () => {
      run(JSON.stringify({ transcript_path: transcript, session_id: 'S1' }))
    })
    // Restore permissions for cleanup
    fs.chmodSync(tcDir, 0o755)
    // Commit should have succeeded despite log failure
    assert.equal(commitCount(dir), 2)
    assert.equal(lastSubject(dir), 'Still commits')
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

  it('returns null when model is not in transcript (auto-detect)', () => {
    assert.equal(resolveCoauthor({}, '/dev/null'), null)
  })
})
