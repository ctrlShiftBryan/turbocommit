const fs = require('fs')
const path = require('path')
const os = require('os')

function logPath () {
  return path.join(os.homedir(), '.claude', 'turbocommit', 'monitor.jsonl')
}

function logEvent (event, meta = {}) {
  try {
    const entry = { event, ...meta, title: meta.title || null, at: Date.now() }
    const p = logPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(entry) + '\n')
  } catch {}
}

module.exports = { logEvent, logPath }
