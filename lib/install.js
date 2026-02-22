const os = require('os')
const path = require('path')
const { loadJson, writeJson } = require('./io')

/**
 * Hook definitions for each Claude Code event turbocommit uses.
 */
const HOOK_DEFS = {
  PreToolUse: {
    matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|mcp__.*',
    hooks: [{ type: 'command', command: 'turbocommit hook pre-tool-use' }]
  },
  SessionStart: {
    hooks: [{ type: 'command', command: 'turbocommit hook session-start' }]
  },
  SessionEnd: {
    hooks: [{ type: 'command', command: 'turbocommit hook session-end' }]
  },
  Stop: {
    hooks: [{ type: 'command', command: 'turbocommit hook stop' }]
  }
}

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

/**
 * Check if turbocommit hooks are installed across all expected events.
 */
function isFullyInstalled (settings) {
  if (!settings || !settings.hooks) return false
  return Object.keys(HOOK_DEFS).every(event =>
    hasTurbocommit(settings.hooks[event])
  )
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
 * Install turbocommit hooks for all 4 events (PreToolUse, SessionStart,
 * SessionEnd, Stop). Each event gets its own group at the end.
 * Cleans up stale entries (including old `turbocommit run`) on install.
 */
function install (settingsPath) {
  settingsPath = settingsPath || getSettingsPath()
  const settings = loadJson(settingsPath) || {}

  if (!settings.hooks) settings.hooks = {}

  // Check if already fully installed
  if (isFullyInstalled(settings)) {
    return { alreadyInstalled: true, settingsPath }
  }

  // Clean all stale turbocommit entries first (including old `turbocommit run`)
  for (const k of Object.keys(settings.hooks)) {
    settings.hooks[k] = removeTurbocommitHooks(settings.hooks[k])
    if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
      delete settings.hooks[k]
    }
  }

  // Install each hook event in its own group at the end
  for (const [event, def] of Object.entries(HOOK_DEFS)) {
    if (!settings.hooks[event]) settings.hooks[event] = []
    const group = { hooks: def.hooks }
    if (def.matcher) group.matcher = def.matcher
    settings.hooks[event].push(group)
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

  // Check if any turbocommit hook exists in any event
  const wasInstalled = Object.keys(settings.hooks).some(event =>
    hasTurbocommit(settings.hooks[event])
  )

  for (const k of Object.keys(settings.hooks)) {
    settings.hooks[k] = removeTurbocommitHooks(settings.hooks[k])
    if (Array.isArray(settings.hooks[k]) && settings.hooks[k].length === 0) {
      delete settings.hooks[k]
    }
  }

  writeJson(settingsPath, settings)
  return { wasInstalled, settingsPath }
}

module.exports = { install, uninstall, hasTurbocommit, isFullyInstalled, getSettingsPath, HOOK_DEFS }
