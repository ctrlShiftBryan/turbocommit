const os = require('os')
const path = require('path')
const { loadJson, writeJson } = require('./io')

const HOOK_ENTRY = { type: 'command', command: 'turbocommit run' }

function getSettingsPath () {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

function hasTurbocommit (groups) {
  if (!Array.isArray(groups)) return false
  return groups.some(g => {
    const hooks = g && g.hooks ? g.hooks : []
    return hooks.some(h => h.command && h.command.includes('turbocommit'))
  })
}

function removeTurbocommitHooks (groups) {
  if (!Array.isArray(groups)) return groups
  return groups.map(g => {
    if (!g || !Array.isArray(g.hooks)) return g
    const filtered = g.hooks.filter(h => !h.command || !h.command.includes('turbocommit'))
    return { ...g, hooks: filtered }
  }).filter(g => g.hooks && g.hooks.length > 0)
}

/**
 * Find the largest Stop group and append turbocommit to its hooks array.
 * If no groups exist, create one.
 */
function install (settingsPath) {
  settingsPath = settingsPath || getSettingsPath()
  const settings = loadJson(settingsPath) || {}

  if (!settings.hooks) settings.hooks = {}

  // Check if already installed
  if (hasTurbocommit(settings.hooks.Stop)) {
    return { alreadyInstalled: true, settingsPath }
  }

  // Clean any stale turbocommit entries first
  for (const k of Object.keys(settings.hooks)) {
    settings.hooks[k] = removeTurbocommitHooks(settings.hooks[k])
    if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
      delete settings.hooks[k]
    }
  }

  // Append to the largest existing Stop group, or create a new one
  if (!settings.hooks.Stop) settings.hooks.Stop = []
  const groups = settings.hooks.Stop

  if (groups.length > 0) {
    const largest = groups.reduce((a, b) =>
      (b.hooks || []).length > (a.hooks || []).length ? b : a
    )
    largest.hooks.push(HOOK_ENTRY)
  } else {
    groups.push({ hooks: [HOOK_ENTRY] })
  }

  writeJson(settingsPath, settings)
  return { alreadyInstalled: false, settingsPath }
}

function uninstall (settingsPath) {
  settingsPath = settingsPath || getSettingsPath()
  const settings = loadJson(settingsPath)

  if (!settings || !settings.hooks) {
    return { wasInstalled: false, settingsPath }
  }

  const wasInstalled = hasTurbocommit(settings.hooks.Stop)

  for (const k of Object.keys(settings.hooks)) {
    settings.hooks[k] = removeTurbocommitHooks(settings.hooks[k])
    if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
      delete settings.hooks[k]
    }
  }

  writeJson(settingsPath, settings)
  return { wasInstalled, settingsPath }
}

module.exports = { install, uninstall, hasTurbocommit, HOOK_ENTRY }
