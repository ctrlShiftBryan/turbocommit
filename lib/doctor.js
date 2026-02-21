const os = require('os')
const path = require('path')
const { loadJson, mergeConfig } = require('./io')
const { hasTurbocommit, getSettingsPath } = require('./install')
const { gitRoot } = require('./git')
const { configPath } = require('./init')

function globalConfigPath () {
  return path.join(os.homedir(), '.claude', 'turbocommit.json')
}

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

  // 3. Group isolation — turbocommit must be the sole hook in the last group
  const tcGroupIndex = findTurbocommitGroup(stopGroups)
  const tcGroup = stopGroups[tcGroupIndex]
  const isLastGroup = tcGroupIndex === stopGroups.length - 1
  const isSoleHook = tcGroup.hooks.length === 1

  if (!isSoleHook) {
    checks.push({ name: 'Group isolation', status: 'warn', message: 'turbocommit shares a group with other hooks — will commit even if another hook blocks' })
  } else if (!isLastGroup) {
    checks.push({ name: 'Group isolation', status: 'warn', message: 'Another group runs after turbocommit' })
  } else {
    checks.push({ name: 'Group isolation', status: 'ok', message: 'Sole hook in last group' })
  }

  // 5. Global turbocommit config
  const globalPath = globalConfigPath()
  const globalCfg = loadJson(globalPath)
  if (globalCfg) {
    checks.push({ name: 'Global config', status: 'ok', message: globalPath })
  } else {
    checks.push({ name: 'Global config', status: 'info', message: 'Not found (optional)' })
  }

  // 6. Local config exists
  const root = gitRoot(cwd)
  if (!root) {
    checks.push({ name: 'Local config', status: 'info', message: 'Not in a git repo — skipping local checks' })
  } else {
    const localPath = configPath(root)
    const localConfig = loadJson(localPath)
    if (!localConfig) {
      if (globalCfg) {
        checks.push({ name: 'Local config', status: 'info', message: 'Not found (using global config)' })
      } else {
        checks.push({ name: 'Local config', status: 'warn', message: `Not found: ${localPath}. Run: turbocommit init` })
      }
    } else {
      checks.push({ name: 'Local config', status: 'ok', message: localPath })
    }

    // 7. Enabled — evaluate merged config
    const merged = mergeConfig(globalCfg || {}, localConfig || {})
    if (merged.enabled !== true) {
      checks.push({ name: 'Enabled', status: 'warn', message: 'enabled is not true in merged config' })
    } else {
      checks.push({ name: 'Enabled', status: 'ok', message: 'Enabled' })
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

module.exports = { doctor }
