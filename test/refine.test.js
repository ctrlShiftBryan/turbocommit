const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const { refine } = require('../lib/refine')
const { saveRefineManifest, readWatermark } = require('../lib/session')
const { ensureDir } = require('../lib/io')

function makeRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-refine-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  return dir
}

function initAndCommit (dir) {
  fs.writeFileSync(path.join(dir, 'README.md'), 'init')
  execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })
}

function headSha (dir) {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim()
}

function lastSubject (dir) {
  return execSync('git log --format=%s -1', { cwd: dir, encoding: 'utf8' }).trim()
}

function lastBody (dir) {
  return execSync('git log --format=%b -1', { cwd: dir, encoding: 'utf8' }).trim()
}

function commitCount (dir) {
  return Number(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim())
}

describe('refine', () => {
  let realHome
  before(() => { realHome = process.env.HOME })
  beforeEach(() => {
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-home-'))
  })
  after(() => { process.env.HOME = realHome })

  it('amends commit with agent title and body', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    // Create a pending commit
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: {
        title: { type: 'agent', command: 'echo "feat: refined title"' },
        body: { type: 'agent', command: 'echo "Refined body content"' }
      },
      effectivePairs: [{ prompt: 'Do something', response: 'Done.' }],
      continuation: '',
      pendingSections: [],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)

    assert.equal(lastSubject(dir), 'feat: refined title')
    assert.equal(lastBody(dir), 'Refined body content')
    assert.equal(commitCount(dir), 2) // still 2 commits (amend, not new)
  })

  it('updates watermark with new SHA after amend', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: { title: { type: 'agent', command: 'echo "refined"' } },
      effectivePairs: [{ prompt: 'Do', response: 'Done.' }],
      continuation: '',
      pendingSections: [],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)

    const wm = readWatermark(dir, 'S1')
    assert.ok(wm)
    assert.equal(wm.pairs, 1)
    const newSha = headSha(dir)
    assert.equal(wm.commit, newSha)
    assert.notEqual(newSha, sha) // amend changes SHA
  })

  it('skips when HEAD has moved past target SHA', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    // Move HEAD forward with another commit
    fs.writeFileSync(path.join(dir, 'file2.txt'), 'more')
    execSync('git add -A && git commit -m "newer commit" --no-verify', { cwd: dir, stdio: 'pipe' })

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: { title: { type: 'agent', command: 'echo "should not appear"' } },
      effectivePairs: [{ prompt: 'Do', response: 'Done.' }],
      continuation: '',
      pendingSections: [],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)

    // Original placeholder commit should be untouched (HEAD moved)
    assert.equal(lastSubject(dir), 'newer commit')
    assert.equal(commitCount(dir), 3)
  })

  it('preserves continuation ref in amended body', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: { title: { type: 'transcript' } },
      effectivePairs: [{ prompt: 'Implement', response: 'Done.' }],
      continuation: 'Continuation of abc1234\n\n',
      pendingSections: [],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)

    const body = lastBody(dir)
    assert.ok(body.startsWith('Continuation of abc1234'))
  })

  it('preserves coauthor trailer in amended body', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: { title: { type: 'transcript' } },
      effectivePairs: [{ prompt: 'Add file', response: 'Done.' }],
      continuation: '',
      pendingSections: [],
      coauthor: 'Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>',
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)

    const body = lastBody(dir)
    assert.ok(body.includes('Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>'))
  })

  it('preserves planning sections in amended body', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: { title: { type: 'transcript' } },
      effectivePairs: [{ prompt: 'Implement', response: 'Created.' }],
      continuation: 'Continuation of abc1234\n\n',
      pendingSections: ['Prompt:\nResearch\n\nResponse:\nFindings'],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)

    const body = lastBody(dir)
    assert.ok(body.includes('## Planning'))
    assert.ok(body.includes('## Implementation'))
    assert.ok(body.includes('Research'))
    assert.ok(body.indexOf('## Planning') < body.indexOf('## Implementation'))
  })

  it('cleans up manifest after success', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: { title: { type: 'transcript' } },
      effectivePairs: [{ prompt: 'Do', response: 'Done.' }],
      continuation: '',
      pendingSections: [],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    assert.ok(fs.existsSync(manifestPath))
    refine(manifestPath)
    assert.ok(!fs.existsSync(manifestPath))
  })

  it('cleans up manifest after skip (HEAD moved)', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    // Move HEAD
    fs.writeFileSync(path.join(dir, 'file2.txt'), 'more')
    execSync('git add -A && git commit -m "moved" --no-verify', { cwd: dir, stdio: 'pipe' })

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: { title: { type: 'transcript' } },
      effectivePairs: [{ prompt: 'Do', response: 'Done.' }],
      continuation: '',
      pendingSections: [],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)
    assert.ok(!fs.existsSync(manifestPath))
  })

  it('handles null manifest gracefully', () => {
    refine('/nonexistent/manifest.json') // should not throw
  })

  it('condenses hook feedback in refine', () => {
    const dir = makeRepo()
    initAndCommit(dir)

    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    const hookText = 'Stop hook feedback:\n' + 'x'.repeat(300)
    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: {
        title: { type: 'transcript' },
        body: { type: 'transcript' },
        condense: { command: 'echo "Build passed, 2 warnings"' }
      },
      effectivePairs: [{ prompt: hookText, response: 'acknowledged' }],
      continuation: '',
      pendingSections: [],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)

    const body = lastBody(dir)
    assert.ok(body.includes('Build passed, 2 warnings'))
    assert.ok(!body.includes('x'.repeat(100)))
  })

  it('pushes after amend when autoPush is true', () => {
    const dir = makeRepo()
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bare-'))
    execSync('git init --bare', { cwd: bare, stdio: 'pipe' })
    initAndCommit(dir)
    execSync(`git remote add origin "${bare}"`, { cwd: dir, stdio: 'pipe' })
    execSync('git push -u origin HEAD', { cwd: dir, stdio: 'pipe' })

    // Phase 1 commits but does NOT push (autoPush deferred to phase 2)
    fs.writeFileSync(path.join(dir, 'file.txt'), 'content')
    execSync('git add -A && git commit -m "placeholder" -m "[tc-pending]" --no-verify', { cwd: dir, stdio: 'pipe' })
    const sha = headSha(dir)

    const manifestPath = saveRefineManifest(dir, sha, {
      root: dir,
      sha,
      sessionId: 'S1',
      config: {
        autoPush: true,
        title: { type: 'agent', command: 'echo "refined"' }
      },
      effectivePairs: [{ prompt: 'Do', response: 'Done.' }],
      continuation: '',
      pendingSections: [],
      coauthor: null,
      pairCount: 1,
      branch: 'main'
    })

    refine(manifestPath)

    const localSha = headSha(dir)
    const remoteSha = execSync('git rev-parse HEAD', { cwd: bare, encoding: 'utf8' }).trim()
    assert.equal(localSha, remoteSha)
  })
})
