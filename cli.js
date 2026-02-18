#!/usr/bin/env node

const { readStdin } = require('./lib/io')
const { install, uninstall } = require('./lib/install')
const { init, deinit } = require('./lib/init')
const { run } = require('./lib/run')

const VERSION = require('./package.json').version

const USAGE = `turbocommit v${VERSION}
Auto-commit after every Claude Code turn.

Commands:
  install     Add turbocommit Stop hook to ~/.claude/settings.json
  uninstall   Remove turbocommit from settings
  init        Create .claude/turbocommit.json in current git repo
  deinit      Remove .claude/turbocommit.json
  run         Hook entry point (reads stdin, auto-commits)
  help        Show this help text
  --version   Show version

Usage:
  turbocommit install     # set up the global hook
  turbocommit init        # enable in a project
  turbocommit run         # called by Claude Code (not manually)
`

function main (argv) {
  const cmd = argv[0]

  switch (cmd) {
    case 'install':
      return cmdInstall()
    case 'uninstall':
      return cmdUninstall()
    case 'init':
      return cmdInit()
    case 'deinit':
      return cmdDeinit()
    case 'run':
      return cmdRun()
    case '--version':
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
  console.log('IMPORTANT: Restart Claude Code for the hook to take effect.')
  console.log('════════════════════════════════════════════════════════════════════')
  console.log('')
  console.log('Next steps:')
  console.log('  1. Restart Claude Code (required)')
  console.log('  2. Run: turbocommit init  in a repo to enable auto-commits')
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

function cmdRun () {
  try {
    const input = readStdin()
    run(input)
  } catch {
    // Never fail — fire and forget
  }
}

main(process.argv.slice(2))
