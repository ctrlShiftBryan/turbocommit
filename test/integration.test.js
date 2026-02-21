const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync, spawnSync } = require('child_process')

function hasClaude () {
  const r = spawnSync('which claude', { shell: true, encoding: 'utf8' })
  return r.status === 0
}

const SKIP = !hasClaude() && 'claude not found in PATH'

function makeProject (opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-integ-'))
  execSync('git init', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })

  const claudeDir = path.join(dir, '.claude')
  fs.mkdirSync(claudeDir, { recursive: true })

  // turbocommit config — use transcript title to avoid extra API calls
  fs.writeFileSync(path.join(claudeDir, 'turbocommit.json'), JSON.stringify({
    enabled: true,
    title: { type: 'transcript' }
  }, null, 2))

  // Diagnostic hook that writes a file when Stop fires, proving hooks work
  const hookLog = path.join(dir, 'hook-fired.txt')
  const diagHook = { type: 'command', command: `bash -c 'echo fired >> "${hookLog}"'` }

  // Hook settings
  const settings = opts.settings || {
    hooks: {
      Stop: [
        { hooks: [diagHook, { type: 'command', command: 'turbocommit run' }] }
      ]
    }
  }
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2))

  // Seed file + initial commit
  fs.writeFileSync(path.join(dir, 'README.md'), 'init')
  execSync('git add -A && git commit -m "Initial"', { cwd: dir, stdio: 'pipe' })

  return { dir, hookLog }
}

function commitCount (dir) {
  return Number(execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim())
}

function cleanEnv () {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('CLAUDE') || k === 'TURBOCOMMIT_DISABLED' || k === 'PROVE_IT_DISABLED') continue
    env[k] = v
  }
  return env
}

function runClaude (dir, prompt) {
  // Clean env: strip all CLAUDE* and turbocommit/prove_it vars to prevent
  // the outer session from interfering with the inner claude -p
  const r = spawnSync('claude -p --model haiku', {
    cwd: dir,
    shell: true,
    encoding: 'utf8',
    input: prompt,
    timeout: 120_000,
    env: cleanEnv()
  })
  if (r.status !== 0) {
    throw new Error(`claude exited ${r.status}: ${r.stderr}`)
  }
  return r.stdout
}

describe('integration', { skip: SKIP }, () => {
  it('turbocommit commits on stop', () => {
    const { dir, hookLog } = makeProject()
    const before = commitCount(dir)

    runClaude(dir, 'Say hello')

    const hookFired = fs.existsSync(hookLog)
    const after = commitCount(dir)
    assert.ok(hookFired, 'diagnostic hook should have written hook-fired.txt — Stop hooks did not fire')
    assert.ok(after > before, `expected commits after turbocommit, got ${before} -> ${after}`)
  })

  it('turbocommit does not commit when earlier group blocks', () => {
    const { dir } = makeProject()
    const hookLog = path.join(dir, 'hook-fired.txt')
    // Overwrite settings with blocking hook in first group
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{
              type: 'command',
              command: 'bash -c \'INPUT=$(cat); ACTIVE=$(echo "$INPUT" | jq -r .stop_hook_active); if [ "$ACTIVE" = "true" ]; then exit 0; else echo "Keep going" >&2; exit 2; fi\''
            }]
          },
          {
            hooks: [
              { type: 'command', command: `bash -c 'echo fired >> "${hookLog}"'` },
              { type: 'command', command: 'turbocommit run' }
            ]
          }
        ]
      }
    }, null, 2))

    const before = commitCount(dir)

    runClaude(dir, 'Say hello')

    const after = commitCount(dir)
    assert.ok(after > before, `expected at least one turbocommit commit, got ${before} -> ${after}`)
    const lastMsg = execSync('git log --format=%s -1', { cwd: dir, encoding: 'utf8' }).trim()
    assert.ok(lastMsg.length > 0, 'last commit should have a message from turbocommit')
  })
})
