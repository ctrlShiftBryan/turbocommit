const fs = require('fs')
const path = require('path')
const { gitRoot } = require('./git')
const { writeJson, ensureDir } = require('./io')

function configPath (root) {
  return path.join(root, '.claude', 'turbocommit.json')
}

function init (cwd) {
  const root = gitRoot(cwd)
  if (!root) {
    return { ok: false, error: 'Not a git repository' }
  }

  const p = configPath(root)
  if (fs.existsSync(p)) {
    return { ok: true, alreadyExists: true, path: p }
  }

  ensureDir(path.dirname(p))
  writeJson(p, { enabled: true })
  return { ok: true, alreadyExists: false, path: p }
}

function deinit (cwd) {
  const root = gitRoot(cwd)
  if (!root) {
    return { ok: false, error: 'Not a git repository' }
  }

  const p = configPath(root)
  if (!fs.existsSync(p)) {
    return { ok: true, existed: false, path: p }
  }

  fs.unlinkSync(p)
  return { ok: true, existed: true, path: p }
}

module.exports = { init, deinit, configPath }
