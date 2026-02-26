/**
 * Wrap prose lines at a specified width while preserving structured
 * Markdown content (code blocks, tables, headers, etc.) verbatim.
 */

function wrapLine (text, maxLen, indent) {
  indent = indent || ''
  const leadMatch = text.match(/^(\s+)/)
  const lead = leadMatch ? leadMatch[1] : ''
  const words = text.trimStart().split(' ')
  if (words.length > 0) words[0] = lead + words[0]
  const lines = []
  let current = ''

  for (const word of words) {
    if (current === '') {
      current = word
    } else if (current.length + 1 + word.length <= maxLen) {
      current += ' ' + word
    } else {
      lines.push(current)
      current = indent + word
    }
  }
  if (current) lines.push(current)
  return lines.join('\n')
}

function wrapText (text, maxLineLength) {
  if (!maxLineLength || typeof maxLineLength !== 'number' || maxLineLength < 1) return text
  if (text === '') return text

  const lines = text.split('\n')
  const result = []
  let inFence = false
  let fencePattern = null

  for (const line of lines) {
    // Fenced code block toggle (backtick or tilde)
    const fenceMatch = line.match(/^(`{3,}|~{3,})/)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fencePattern = fenceMatch[1]
        result.push(line)
        continue
      } else if (line.startsWith(fencePattern) && line.trim() === fencePattern) {
        inFence = false
        fencePattern = null
        result.push(line)
        continue
      }
    }

    // Inside fenced block — preserve verbatim
    if (inFence) {
      result.push(line)
      continue
    }

    // Blank line
    if (line === '') {
      result.push(line)
      continue
    }

    // Indented code (4+ spaces or tab)
    if (/^( {4,}|\t)/.test(line)) {
      result.push(line)
      continue
    }

    // Header
    if (/^#{1,6}\s/.test(line)) {
      result.push(line)
      continue
    }

    // Table row (starts with |)
    if (/^\|/.test(line.trimStart())) {
      result.push(line)
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      result.push(line)
      continue
    }

    // Blockquote
    const bqMatch = line.match(/^((?:>\s?)+)/)
    if (bqMatch) {
      const prefix = bqMatch[0]
      const indent = bqMatch[1].replace(/\s?$/, ' ')
      if (line.length <= maxLineLength) {
        result.push(line)
      } else {
        const content = line.slice(prefix.length)
        result.push(wrapLine(prefix + content, maxLineLength, indent))
      }
      continue
    }

    // List item
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s/)
    if (listMatch) {
      const prefix = listMatch[0]
      const indent = ' '.repeat(prefix.length)
      if (line.length <= maxLineLength) {
        result.push(line)
      } else {
        result.push(wrapLine(line, maxLineLength, indent))
      }
      continue
    }

    // Prose — wrap at word boundaries
    if (line.length <= maxLineLength) {
      result.push(line)
    } else {
      result.push(wrapLine(line, maxLineLength, ''))
    }
  }

  return result.join('\n')
}

module.exports = { wrapText }
