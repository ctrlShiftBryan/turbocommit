const fs = require('fs')

/**
 * Parse a JSONL transcript file into prompt/response pairs.
 * Returns array of { prompt, response } objects.
 */
function parseTranscript (filePath) {
  if (!filePath || !fs.existsSync(filePath)) return []

  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  const state = { pairs: [], prompt: null, response: '' }

  for (const line of lines) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }

    if (entry.type === 'user' && typeof entry.message?.content === 'string') {
      if (state.prompt !== null) {
        state.pairs.push({ prompt: state.prompt, response: state.response })
      }
      state.prompt = entry.message.content
      state.response = ''
    } else if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const hasToolUse = entry.message.content.some(b => b.type === 'tool_use')
      if (hasToolUse) continue
      const texts = entry.message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
      state.response += texts.join('')
    }
  }

  if (state.prompt !== null) {
    state.pairs.push({ prompt: state.prompt, response: state.response })
  }

  return state.pairs
}

/**
 * Format prompt/response pairs into a commit body.
 */
function formatBody (pairs) {
  if (pairs.length === 0) return '(no transcript)'
  return pairs
    .map(p => `Prompt:\n${p.prompt}\n\nResponse:\n${p.response}`)
    .join('\n\n---\n\n')
}

/**
 * Extract a headline from the last user prompt.
 * Falls back to a timestamped default.
 */
function extractHeadline (pairs) {
  if (pairs.length === 0) return fallbackHeadline()
  const lastPrompt = pairs[pairs.length - 1].prompt
  if (!lastPrompt) return fallbackHeadline()
  const firstLine = lastPrompt.split('\n')[0]
  return firstLine.slice(0, 72) || fallbackHeadline()
}

function fallbackHeadline () {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `auto-commit ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

module.exports = { parseTranscript, formatBody, extractHeadline, fallbackHeadline }
