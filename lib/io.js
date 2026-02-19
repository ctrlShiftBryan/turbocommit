const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

function readStdin () {
  return fs.readFileSync(0, 'utf8')
}

function loadJson (p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

function writeJson (p, obj) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

function ensureDir (p) {
  fs.mkdirSync(p, { recursive: true })
}

function tryRun (cmd, opts) {
  const { input, ...rest } = opts || {}
  let r
  try {
    r = spawnSync(cmd, {
      ...rest,
      ...(input != null ? { input } : {}),
      shell: true,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024
    })
  } catch {
    return { code: 1, signal: null, stdout: '', stderr: '' }
  }
  return { code: r.status ?? (r.signal || r.error ? 1 : 0), signal: r.signal || null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function mergeConfig (global, project) {
  const result = { ...global }
  for (const key of Object.keys(project)) {
    if (
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key]) &&
      typeof project[key] === 'object' && project[key] !== null && !Array.isArray(project[key])
    ) {
      result[key] = { ...result[key], ...project[key] }
    } else {
      result[key] = project[key]
    }
  }
  return result
}

module.exports = { readStdin, loadJson, writeJson, ensureDir, tryRun, mergeConfig }
