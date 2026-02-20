const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { parseTranscript, formatBody, extractHeadline, fallbackHeadline, extractModel } = require('../lib/transcript')

function tmpJsonl (lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
  const file = path.join(dir, 'transcript.jsonl')
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return file
}

describe('parseTranscript', () => {
  it('returns empty array for missing file', () => {
    assert.deepStrictEqual(parseTranscript('/nonexistent'), [])
  })

  it('returns empty array for null path', () => {
    assert.deepStrictEqual(parseTranscript(null), [])
  })

  it('parses a single prompt/response pair', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Fix the bug' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].prompt, 'Fix the bug')
    assert.equal(pairs[0].response, 'Done.')
  })

  it('parses multiple prompt/response pairs', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'First prompt' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'First response' }] } },
      { type: 'user', message: { content: 'Second prompt' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Second response' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 2)
    assert.equal(pairs[0].prompt, 'First prompt')
    assert.equal(pairs[1].prompt, 'Second prompt')
  })

  it('skips assistant entries that contain tool_use blocks', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Go' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Internal narration' },
            { type: 'tool_use', name: 'Read' },
            { type: 'text', text: 'More narration' }
          ]
        }
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Final response.' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs[0].response, 'Final response.')
  })

  it('returns empty response when all assistant entries have tool_use', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Go' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Narration before tool' },
            { type: 'tool_use', name: 'Edit' }
          ]
        }
      }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].response, '')
  })

  it('concatenates multiple assistant entries', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Go' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Chunk 1 ' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Chunk 2' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs[0].response, 'Chunk 1 Chunk 2')
  })

  it('skips non-string user messages', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: [{ type: 'image' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Saw image' }] } },
      { type: 'user', message: { content: 'Real prompt' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Real response' }] } }
    ])
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].prompt, 'Real prompt')
  })

  it('handles malformed JSON lines gracefully', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { content: 'Hello' } }),
      'this is not json',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } })
    ].join('\n'))
    const pairs = parseTranscript(file)
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].prompt, 'Hello')
  })

  it('handles empty file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, '')
    assert.deepStrictEqual(parseTranscript(file), [])
  })
})

describe('formatBody', () => {
  it('returns "(no transcript)" for empty pairs', () => {
    assert.equal(formatBody([]), '(no transcript)')
  })

  it('formats single pair', () => {
    const result = formatBody([{ prompt: 'Fix it', response: 'Fixed.' }])
    assert.equal(result, 'Prompt:\nFix it\n\nResponse:\nFixed.')
  })

  it('joins multiple pairs with separator', () => {
    const result = formatBody([
      { prompt: 'A', response: 'B' },
      { prompt: 'C', response: 'D' }
    ])
    assert.ok(result.includes('---'))
    assert.ok(result.includes('Prompt:\nA'))
    assert.ok(result.includes('Prompt:\nC'))
  })
})

describe('extractHeadline', () => {
  it('returns fallback for empty pairs', () => {
    const headline = extractHeadline([])
    assert.match(headline, /^auto-commit \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('uses first line of last prompt', () => {
    const headline = extractHeadline([
      { prompt: 'First thing', response: '' },
      { prompt: 'Second thing\nMore details', response: '' }
    ])
    assert.equal(headline, 'Second thing')
  })

  it('truncates to 72 chars', () => {
    const longLine = 'A'.repeat(100)
    const headline = extractHeadline([{ prompt: longLine, response: '' }])
    assert.equal(headline.length, 72)
  })
})

describe('fallbackHeadline', () => {
  it('matches expected format', () => {
    assert.match(fallbackHeadline(), /^auto-commit \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('extractModel', () => {
  it('returns null for missing file', () => {
    assert.equal(extractModel('/nonexistent'), null)
  })

  it('returns null for null path', () => {
    assert.equal(extractModel(null), null)
  })

  it('extracts model from first assistant entry', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'Hi' }] } }
    ])
    assert.equal(extractModel(file), 'claude-opus-4-6')
  })

  it('skips entries without model field', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
      { type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Bye' }] } }
    ])
    assert.equal(extractModel(file), 'claude-sonnet-4-6')
  })

  it('returns null when no assistant entries have model', () => {
    const file = tmpJsonl([
      { type: 'user', message: { content: 'Hello' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }
    ])
    assert.equal(extractModel(file), null)
  })

  it('returns null for empty file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-transcript-'))
    const file = path.join(dir, 'transcript.jsonl')
    fs.writeFileSync(file, '')
    assert.equal(extractModel(file), null)
  })
})
