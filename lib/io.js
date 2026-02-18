const fs = require('fs')
const path = require('path')

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

module.exports = { readStdin, loadJson, writeJson, ensureDir }
