#!/usr/bin/env node

const { readStdin } = require('./lib/io')
const { install, uninstall } = require('./lib/install')
const { init, deinit } = require('./lib/init')
const { run } = require('./lib/run')
const { refine } = require('./lib/refine')
const { handleTrack } = require('./lib/track')
const { handleSessionStart, handleSessionEnd } = require('./lib/session')
const { doctor } = require('./lib/doctor')
const { monitor } = require('./lib/monitor')
const { gitRoot } = require('./lib/git')

const VERSION = require('./package.json').version

const USAGE = `turbocommit v${VERSION}
Auto-commit after every Claude Code turn.

Commands:
  install     Add turbocommit hooks to ~/.claude/settings.json
  uninstall   Remove turbocommit from settings
  init        Create .claude/turbocommit.json in current git repo
  deinit      Remove .claude/turbocommit.json
  doctor      Check hook and config health
  monitor     Tail the event log (start/success/fail)
  hook        Hook entry points (called by Claude Code, not manually)
  help        Show this help text
  --version, -v  Show version

Usage:
  node cli.js install     # set up the global hooks
  node cli.js init        # enable in a project
  node cli.js doctor      # verify everything is wired correctly
  node cli.js monitor     # watch commits in real-time

Install via skills.sh:
  npx skills add ctrlshiftbryan/turbocommit
  node ~/.claude/skills/turbocommit/cli.js install

Install via git clone:
  git clone https://github.com/ctrlShiftBryan/turbocommit ~/.claude/turbocommit
  node ~/.claude/turbocommit/cli.js install
`

function main (argv) {
  const cmd = argv[0]

  switch (cmd) {
    case 'install':
      return cmdInstall()
    case 'uninstall':
      return cmdUninstall()
    case 'doctor':
      return cmdDoctor()
    case 'monitor':
      return cmdMonitor()
    case 'init':
      return cmdInit()
    case 'deinit':
      return cmdDeinit()
    case 'hook':
      return cmdHook(argv.slice(1))
    case 'run':
      return cmdRunDeprecated()
    case '--version':
    case '-v':
    case 'version':
      console.log(VERSION)
      return
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE)
      return
    default:
      console.error(`Unknown command: ${cmd}`)
      console.error('Run "turbocommit help" for usage.')
      process.exitCode = 1
  }
}

function cmdInstall () {
  const result = install()
  if (result.alreadyInstalled) {
    console.log('turbocommit already installed.')
    console.log(`  Settings: ${result.settingsPath}`)
    return
  }
  console.log('turbocommit installed.')
  console.log(`  Settings: ${result.settingsPath}`)
  console.log('')
  console.log('════════════════════════════════════════════════════════════════════')
  console.log('IMPORTANT: Restart Claude Code for the hooks to take effect.')
  console.log('════════════════════════════════════════════════════════════════════')
  console.log('')
  console.log('Next steps:')
  console.log('  1. Restart Claude Code (required)')
  console.log('  2. Run: node <path>/cli.js init  in a repo to enable auto-commits')
}

function cmdUninstall () {
  const result = uninstall()
  if (!result.wasInstalled) {
    console.log('turbocommit was not installed.')
    return
  }
  console.log('turbocommit uninstalled.')
  console.log(`  Settings: ${result.settingsPath}`)
}

function cmdInit () {
  const result = init()
  if (!result.ok) {
    console.error(`Error: ${result.error}`)
    process.exitCode = 1
    return
  }
  if (result.alreadyExists) {
    console.log('turbocommit already enabled in this repo.')
    console.log(`  Config: ${result.path}`)
    return
  }
  console.log('turbocommit enabled.')
  console.log(`  Config: ${result.path}`)
}

function cmdDeinit () {
  const result = deinit()
  if (!result.ok) {
    console.error(`Error: ${result.error}`)
    process.exitCode = 1
    return
  }
  if (!result.existed) {
    console.log('turbocommit was not enabled in this repo.')
    return
  }
  console.log('turbocommit disabled.')
  console.log(`  Removed: ${result.path}`)
}

function cmdDoctor () {
  const STATUS = { ok: '  ok', warn: 'warn', error: ' err', info: 'info' }
  const result = doctor()
  for (const check of result.checks) {
    console.log(`[${STATUS[check.status] || check.status}] ${check.name}: ${check.message}`)
  }
  if (!result.ok) {
    process.exitCode = 1
  }
}

function cmdMonitor () {
  monitor()
}

function cmdHook (argv) {
  const event = argv[0]
  try {
    const input = readStdin()
    const root = gitRoot()
    switch (event) {
      case 'pre-tool-use':
        handleTrack(input, root)
        return
      case 'session-start':
        handleSessionStart(input, root)
        return
      case 'session-end':
        handleSessionEnd(input, root)
        return
      case 'stop':
        run(input)
        break
      case 'refine':
        // Refine reads manifest path from argv, not stdin
        refine(argv[1])
        return
      default:
        // Unknown hook event — ignore silently (never fail)
        break
    }
  } catch {
    // Never fail — fire and forget
  }
}

function cmdRunDeprecated () {
  let hookInput
  try {
    hookInput = JSON.parse(readStdin())
  } catch {
    hookInput = {}
  }
  // Prevent infinite loop: if we already blocked once, let Claude stop
  if (hookInput.stop_hook_active) return
  const msg = 'turbocommit hooks are outdated (v0.6). ' +
    'Auto-commits are paused until you upgrade. ' +
    'Run: turbocommit install'
  // Block the stop so the agent sees the reason and can relay it to the user
  const output = JSON.stringify({ decision: 'block', reason: msg })
  process.stdout.write(output + '\n')
}

main(process.argv.slice(2))
