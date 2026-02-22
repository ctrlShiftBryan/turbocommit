const os = require('os')
const path = require('path')
const { loadJson, mergeConfig } = require('./io')
const { hasTurbocommit, isFullyInstalled, getSettingsPath, HOOK_DEFS } = require('./install')
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

  // 2. All hooks installed
  if (!isFullyInstalled(settings)) {
    const missing = Object.keys(HOOK_DEFS).filter(event =>
      !hasTurbocommit((settings.hooks && settings.hooks[event]) || [])
    )
    checks.push({ name: 'Hooks installed', status: 'error', message: `Missing hooks: ${missing.join(', ')}. Run: turbocommit uninstall && turbocommit install` })
    return { ok: false, checks }
  }
  checks.push({ name: 'Hooks installed', status: 'ok', message: `All ${Object.keys(HOOK_DEFS).length} hooks installed` })

  // 3. Stop group isolation — turbocommit must be the sole hook in the last group
  const stopGroups = (settings.hooks && settings.hooks.Stop) || []
  const tcGroupIndex = findTurbocommitGroup(stopGroups)
  if (tcGroupIndex >= 0) {
    const tcGroup = stopGroups[tcGroupIndex]
    const isLastGroup = tcGroupIndex === stopGroups.length - 1
    const isSoleHook = tcGroup.hooks.length === 1

    if (!isSoleHook) {
      checks.push({ name: 'Group isolation', status: 'warn', message: 'turbocommit shares a Stop group with other hooks — will commit even if another hook blocks' })
    } else if (!isLastGroup) {
      checks.push({ name: 'Group isolation', status: 'warn', message: 'Another group runs after turbocommit in Stop' })
    } else {
      checks.push({ name: 'Group isolation', status: 'ok', message: 'Sole hook in last Stop group' })
    }
  }

  // 4. Global turbocommit config
  const globalPath = globalConfigPath()
  const globalCfg = loadJson(globalPath)
  if (globalCfg) {
    checks.push({ name: 'Global config', status: 'ok', message: globalPath })
  } else {
    checks.push({ name: 'Global config', status: 'info', message: 'Not found (optional)' })
  }

  // 5. Local config exists
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

    // 6. Enabled — evaluate merged config
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
