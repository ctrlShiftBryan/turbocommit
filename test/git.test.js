const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const {
  gitRoot, hasChanges, countEmptyMarkers, collectBodies,
  commitEmpty, addAndCommit, softReset, hasCommits
} = require('../lib/git')

function makeRepo () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  return dir
}

function makeRepoWithCommit () {
  const dir = makeRepo()
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello')
  execSync('git add -A && git commit -m "Initial commit"', { cwd: dir, stdio: 'pipe' })
  return dir
}

describe('gitRoot', () => {
  it('returns root for a git repo', () => {
    const dir = makeRepo()
    // Resolve symlinks (macOS /tmp -> /private/tmp)
    const resolved = fs.realpathSync(dir)
    assert.equal(gitRoot(dir), resolved)
  })

  it('returns null for non-repo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nogit-'))
    assert.equal(gitRoot(dir), null)
  })
})

describe('hasChanges', () => {
  it('returns false for clean repo', () => {
    const dir = makeRepoWithCommit()
    assert.equal(hasChanges(dir), false)
  })

  it('returns true for unstaged changes', () => {
    const dir = makeRepoWithCommit()
    fs.writeFileSync(path.join(dir, 'README.md'), 'modified')
    assert.equal(hasChanges(dir), true)
  })

  it('returns true for untracked files', () => {
    const dir = makeRepoWithCommit()
    fs.writeFileSync(path.join(dir, 'new.txt'), 'new file')
    assert.equal(hasChanges(dir), true)
  })
})

describe('hasCommits', () => {
  it('returns false for empty repo', () => {
    const dir = makeRepo()
    assert.equal(hasCommits(dir), false)
  })

  it('returns true after a commit', () => {
    const dir = makeRepoWithCommit()
    assert.equal(hasCommits(dir), true)
  })
})

describe('commitEmpty', () => {
  it('creates an empty commit with 🫥 marker', () => {
    const dir = makeRepoWithCommit()
    commitEmpty(dir, 'test headline', 'test body')
    const subject = execSync('git log --format=%s -1', { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(subject, 'test headline 🫥')
  })
})

describe('addAndCommit', () => {
  it('commits file changes', () => {
    const dir = makeRepoWithCommit()
    fs.writeFileSync(path.join(dir, 'new.txt'), 'content')
    addAndCommit(dir, 'added file', 'body text')
    const subject = execSync('git log --format=%s -1', { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(subject, 'added file')
    // Verify the file is committed
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(status, '')
  })
})

describe('countEmptyMarkers', () => {
  it('returns 0 for no marker commits', () => {
    const dir = makeRepoWithCommit()
    assert.equal(countEmptyMarkers(dir), 0)
  })

  it('counts contiguous 🫥 commits', () => {
    const dir = makeRepoWithCommit()
    commitEmpty(dir, 'first', 'body 1')
    commitEmpty(dir, 'second', 'body 2')
    assert.equal(countEmptyMarkers(dir), 2)
  })

  it('stops at non-marker commit', () => {
    const dir = makeRepoWithCommit()
    commitEmpty(dir, 'empty', 'body')
    // Add a real commit
    fs.writeFileSync(path.join(dir, 'file.txt'), 'data')
    addAndCommit(dir, 'real commit', 'real body')
    // Add another marker
    commitEmpty(dir, 'after', 'body')
    assert.equal(countEmptyMarkers(dir), 1)
  })
})

describe('collectBodies', () => {
  it('collects bodies oldest first', () => {
    const dir = makeRepoWithCommit()
    commitEmpty(dir, 'first', 'body-1')
    commitEmpty(dir, 'second', 'body-2')
    const bodies = collectBodies(dir, 2)
    assert.equal(bodies.length, 2)
    assert.equal(bodies[0], 'body-1')
    assert.equal(bodies[1], 'body-2')
  })
})

describe('softReset', () => {
  it('resets N commits keeping working tree', () => {
    const dir = makeRepoWithCommit()
    commitEmpty(dir, 'extra', 'body')
    const countBefore = execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    softReset(dir, 1)
    const countAfter = execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim()
    assert.equal(Number(countBefore) - Number(countAfter), 1)
  })
})
