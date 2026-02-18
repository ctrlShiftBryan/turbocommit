const { loadJson } = require('./io')
const { hasTurbocommit, getSettingsPath } = require('./install')
const { gitRoot } = require('./git')
const { configPath } = require('./init')

function doctor (settingsPath, cwd) {
  settingsPath = settingsPath || getSettingsPath()
  cwd = cwd || process.cwd()
  const checks = []

  // 1. Global settings exist
  const settings = loadJson(settingsPath)
  if (!settings) {
    checks.push({ name: 'Global settings', status: 'error', message: `Not found: ${settingsPath}` })
    return { ok: false, checks }
  }
  checks.push({ name: 'Global settings', status: 'ok', message: settingsPath })

  // 2. Hook installed
  const stopGroups = (settings.hooks && settings.hooks.Stop) || []
  if (!hasTurbocommit(stopGroups)) {
    checks.push({ name: 'Hook installed', status: 'error', message: 'turbocommit not found in Stop hooks. Run: turbocommit install' })
    return { ok: false, checks }
  }
  checks.push({ name: 'Hook installed', status: 'ok', message: 'Found in Stop hooks' })

  // 3. Last hook in Stop — turbocommit should be last entry in last group
  const tcGroupIndex = findTurbocommitGroup(stopGroups)
  const tcGroup = stopGroups[tcGroupIndex]
  const tcHookIndex = findTurbocommitHook(tcGroup.hooks)
  const isLastInGroup = tcHookIndex === tcGroup.hooks.length - 1
  const isLastGroup = tcGroupIndex === stopGroups.length - 1

  if (!isLastInGroup) {
    checks.push({ name: 'Last hook in Stop', status: 'warn', message: 'turbocommit is not the last hook in its group — later hooks may cause uncommitted changes' })
  } else if (!isLastGroup) {
    checks.push({ name: 'Last hook in Stop', status: 'warn', message: 'Another group runs after turbocommit — later hooks may cause uncommitted changes' })
  } else {
    checks.push({ name: 'Last hook in Stop', status: 'ok', message: 'Runs last' })
  }

  // 4. Grouping opportunity — sole hook in own group with other groups
  if (tcGroup.hooks.length === 1 && stopGroups.length > 1) {
    const largest = stopGroups.reduce((a, b) =>
      (b.hooks || []).length > (a.hooks || []).length ? b : a
    )
    const largestSize = (largest.hooks || []).length
    checks.push({ name: 'Grouping opportunity', status: 'warn', message: `turbocommit is alone in its group — could be combined into the largest group (${largestSize} hooks)` })
  }

  // 5. Local config exists
  const root = gitRoot(cwd)
  if (!root) {
    checks.push({ name: 'Local config', status: 'info', message: 'Not in a git repo — skipping local checks' })
  } else {
    const localPath = configPath(root)
    const localConfig = loadJson(localPath)
    if (!localConfig) {
      checks.push({ name: 'Local config', status: 'warn', message: `Not found: ${localPath}. Run: turbocommit init` })
    } else {
      checks.push({ name: 'Local config', status: 'ok', message: localPath })

      // 6. Enabled is true
      if (localConfig.enabled !== true) {
        checks.push({ name: 'Enabled', status: 'warn', message: 'enabled is not true in local config' })
      } else {
        checks.push({ name: 'Enabled', status: 'ok', message: 'Enabled' })
      }
    }
  }

  const ok = checks.every(c => c.status !== 'error')
  return { ok, checks }
}

function findTurbocommitGroup (groups) {
  for (let i = 0; i < groups.length; i++) {
    const hooks = (groups[i] && groups[i].hooks) || []
    if (hooks.some(h => h.command && h.command.includes('turbocommit'))) {
      return i
    }
  }
  return -1
}

function findTurbocommitHook (hooks) {
  for (let i = 0; i < hooks.length; i++) {
    if (hooks[i].command && hooks[i].command.includes('turbocommit')) {
      return i
    }
  }
  return -1
}

module.exports = { doctor }
