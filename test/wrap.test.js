const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { wrapText } = require('../lib/wrap')

describe('wrapText', () => {
  // --- Passthrough / disabled ---

  describe('passthrough', () => {
    it('returns text unchanged when maxLineLength is false', () => {
      const text = 'This is a long line that should not be wrapped at all because wrapping is disabled'
      assert.equal(wrapText(text, false), text)
    })

    it('returns text unchanged when maxLineLength is undefined', () => {
      const text = 'This is a long line that should not be wrapped at all because wrapping is disabled'
      assert.equal(wrapText(text, undefined), text)
    })

    it('returns text unchanged when maxLineLength is 0', () => {
      const text = 'This is a long line that should not be wrapped at all because wrapping is disabled'
      assert.equal(wrapText(text, 0), text)
    })

    it('returns text unchanged when maxLineLength is negative', () => {
      const text = 'This is a long line that should not be wrapped at all because wrapping is disabled'
      assert.equal(wrapText(text, -5), text)
    })

    it('returns empty string for empty input', () => {
      assert.equal(wrapText('', 72), '')
    })
  })

  // --- Prose wrapping ---

  describe('prose wrapping', () => {
    it('leaves short line unchanged', () => {
      assert.equal(wrapText('Hello world', 72), 'Hello world')
    })

    it('wraps long line at word boundary', () => {
      const input = 'The quick brown fox jumps over the lazy dog and keeps running across the field'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines.length > 1, 'should wrap into multiple lines')
      for (const line of lines) {
        assert.ok(line.length <= 40, `line exceeds limit: "${line}" (${line.length})`)
      }
      // Verify all words are preserved
      assert.equal(result.replace(/\n/g, ' '), input)
    })

    it('wraps line exactly at limit — unchanged', () => {
      const input = 'abcde fghij'
      assert.equal(wrapText(input, 11), input)
    })

    it('wraps line one char over limit', () => {
      const input = 'abcde fghijk'
      const result = wrapText(input, 11)
      assert.equal(result, 'abcde\nfghijk')
    })

    it('preserves word that exceeds limit (no mid-word break)', () => {
      const input = 'supercalifragilisticexpialidocious'
      assert.equal(wrapText(input, 10), input)
    })

    it('wraps multiple paragraphs independently', () => {
      const input = 'First paragraph that is long enough to wrap at this width.\n\nSecond paragraph that is also long enough to wrap at this width.'
      const result = wrapText(input, 30)
      // Both paragraphs should be wrapped, blank line preserved
      assert.ok(result.includes('\n\n'), 'blank line between paragraphs preserved')
      const paragraphs = result.split('\n\n')
      assert.equal(paragraphs.length, 2)
    })

    it('preserves consecutive blank lines between paragraphs', () => {
      const input = 'First paragraph.\n\n\nSecond paragraph.'
      const result = wrapText(input, 72)
      assert.ok(result.includes('\n\n\n'), 'consecutive blank lines preserved')
    })
  })

  // --- Fenced code blocks ---

  describe('fenced code blocks', () => {
    it('preserves short fenced code block verbatim', () => {
      const input = '```\nshort code\n```'
      assert.equal(wrapText(input, 72), input)
    })

    it('preserves long lines inside fenced code block', () => {
      const longLine = 'x'.repeat(200)
      const input = `\`\`\`\n${longLine}\n\`\`\``
      assert.equal(wrapText(input, 72), input)
    })

    it('handles fenced block with language tag', () => {
      const longLine = 'const result = someFunction(argument1, argument2, argument3, argument4, argument5)'
      const input = `\`\`\`js\n${longLine}\n\`\`\``
      assert.equal(wrapText(input, 40), input)
    })

    it('handles nested/escaped backticks inside fenced block', () => {
      const input = '````\nSome `inline` and ```nested``` backticks\n````'
      assert.equal(wrapText(input, 20), input)
    })

    it('preserves tilde-fenced code block verbatim', () => {
      const longLine = 'some very long line of code that should not be wrapped at all because it is inside a fence'
      const input = `~~~\n${longLine}\n~~~`
      assert.equal(wrapText(input, 40), input)
    })

    it('handles tilde fence with language tag', () => {
      const longLine = 'const result = someFunction(argument1, argument2, argument3, argument4)'
      const input = `~~~js\n${longLine}\n~~~`
      assert.equal(wrapText(input, 40), input)
    })

    it('handles multiple fenced blocks with prose between them', () => {
      const input = [
        '```',
        'code block one with a very long line that should not be wrapped',
        '```',
        '',
        'This is prose between code blocks that should be wrapped at the limit.',
        '',
        '```',
        'code block two with a very long line that should not be wrapped',
        '```'
      ].join('\n')
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      // Code lines should be unchanged
      assert.equal(lines[1], 'code block one with a very long line that should not be wrapped')
      assert.equal(lines[lines.length - 2], 'code block two with a very long line that should not be wrapped')
      // Prose should be wrapped
      const proseStart = lines.indexOf('') + 1
      assert.ok(lines[proseStart].length <= 40, 'prose line should be wrapped')
    })
  })

  // --- Indented lines ---

  describe('indented lines', () => {
    it('preserves 4-space indented line verbatim', () => {
      const input = '    This is indented code that should not be wrapped even if it is really long'
      assert.equal(wrapText(input, 20), input)
    })

    it('preserves tab-indented line verbatim', () => {
      const input = '\tThis is tab-indented code that should not be wrapped even if it is really long'
      assert.equal(wrapText(input, 20), input)
    })

    it('wraps lines with less than 4 spaces of indent as prose', () => {
      const input = '   This line has 3 spaces and should be wrapped when it gets too long for the limit'
      const result = wrapText(input, 40)
      assert.ok(result.includes('\n'), 'should be wrapped')
    })

    it('preserves leading whitespace on prose with less than 4 spaces', () => {
      const input = '   Leading spaces and a long line that should be wrapped at the configured limit'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines[0].startsWith('   '), 'first line preserves leading spaces')
    })
  })

  // --- Headers ---

  describe('headers', () => {
    it('preserves # header line verbatim even if long', () => {
      const input = '# This is a very long header that exceeds the maximum line length but should be preserved'
      assert.equal(wrapText(input, 20), input)
    })

    it('preserves ## through ###### headers', () => {
      const headers = [
        '## Level two header that is very long and should not be wrapped',
        '### Level three header that is very long and should not be wrapped',
        '#### Level four header that is very long and should not be wrapped',
        '##### Level five header that is very long and should not be wrapped',
        '###### Level six header that is very long and should not be wrapped'
      ]
      for (const h of headers) {
        assert.equal(wrapText(h, 20), h, `header not preserved: ${h.slice(0, 30)}...`)
      }
    })
  })

  // --- Lists ---

  describe('lists', () => {
    it('leaves short list item unchanged', () => {
      const input = '- Short item'
      assert.equal(wrapText(input, 72), input)
    })

    it('wraps long unordered list item with continuation indent', () => {
      const input = '- This is a very long list item that should be wrapped at the specified maximum line length limit'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines.length > 1, 'should wrap')
      assert.ok(lines[0].startsWith('- '), 'first line keeps marker')
      for (let i = 1; i < lines.length; i++) {
        assert.ok(lines[i].startsWith('  '), `continuation line ${i} should be indented`)
        assert.ok(!lines[i].startsWith('  -'), 'continuation should not have marker')
      }
    })

    it('wraps long ordered list item with continuation indent', () => {
      const input = '1. This is a very long ordered list item that should be wrapped at the specified maximum line length limit'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines.length > 1, 'should wrap')
      assert.ok(lines[0].startsWith('1. '), 'first line keeps marker')
      for (let i = 1; i < lines.length; i++) {
        assert.ok(lines[i].startsWith('   '), `continuation line ${i} should be indented (3 spaces for "1. ")`)
      }
    })

    it('wraps nested list item preserving leading indent', () => {
      const input = '  - This is a nested list item that needs wrapping at the limit we set'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines.length > 1, 'should wrap')
      assert.ok(lines[0].startsWith('  - '), 'first line keeps leading indent and marker')
      for (let i = 1; i < lines.length; i++) {
        assert.ok(lines[i].startsWith('    '), `continuation line ${i} should have 4-space indent`)
      }
    })

    it('wraps long * list item with continuation indent', () => {
      const input = '* This is a very long star list item that should be wrapped at the specified maximum line length limit'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines.length > 1, 'should wrap')
      assert.ok(lines[0].startsWith('* '), 'first line keeps marker')
      for (let i = 1; i < lines.length; i++) {
        assert.ok(lines[i].startsWith('  '), `continuation line ${i} should be indented`)
      }
    })
  })

  // --- Tables ---

  describe('tables', () => {
    it('preserves markdown table row verbatim', () => {
      const input = '| Column 1 | Column 2 | Column 3 | A really long column value that exceeds the limit |'
      assert.equal(wrapText(input, 20), input)
    })

    it('preserves table separator row', () => {
      const input = '|---|---|---|'
      assert.equal(wrapText(input, 5), input)
    })

    it('wraps prose containing pipe characters (not a table)', () => {
      const input = 'Run git log --oneline | head -5 to see the recent commits in the repository'
      const result = wrapText(input, 40)
      assert.ok(result.includes('\n'), 'should be wrapped, not treated as table')
    })
  })

  // --- Horizontal rules ---

  describe('horizontal rules', () => {
    it('preserves --- separator line', () => {
      const input = '---'
      assert.equal(wrapText(input, 72), input)
    })

    it('preserves *** separator line', () => {
      const input = '***'
      assert.equal(wrapText(input, 72), input)
    })
  })

  // --- Blockquotes ---

  describe('blockquotes', () => {
    it('preserves short blockquote unchanged', () => {
      const input = '> Short quote'
      assert.equal(wrapText(input, 72), input)
    })

    it('wraps long blockquote with > prefix on continuation lines', () => {
      const input = '> This is a very long blockquote line that should be wrapped at the specified maximum line length limit'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines.length > 1, 'should wrap')
      for (const line of lines) {
        assert.ok(line.startsWith('> '), `every line should start with "> ": "${line}"`)
        assert.ok(line.length <= 40, `line exceeds limit: "${line}" (${line.length})`)
      }
    })

    it('wraps nested blockquote preserving prefix (contiguous)', () => {
      const input = '>> This is a nested blockquote line that should be wrapped at the specified maximum line length'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines.length > 1, 'should wrap')
      for (const line of lines) {
        assert.ok(line.startsWith('>> '), `every line should start with ">> ": "${line}"`)
      }
    })

    it('wraps nested blockquote preserving prefix (spaced)', () => {
      const input = '> > This is a spaced nested blockquote that should be wrapped at the specified maximum line length'
      const result = wrapText(input, 40)
      const lines = result.split('\n')
      assert.ok(lines.length > 1, 'should wrap')
      for (const line of lines) {
        assert.ok(line.startsWith('> > '), `every line should start with "> > ": "${line}"`)
      }
    })
  })

  // --- Mixed content (integration) ---

  describe('mixed content', () => {
    it('handles realistic mixed document', () => {
      const input = [
        '# Session Summary',
        '',
        'This is a paragraph of prose that describes what happened during the coding session and should be wrapped at the limit.',
        '',
        '```js',
        'const result = someFunction(argument1, argument2, argument3, argument4)',
        '```',
        '',
        '- First item is short',
        '- Second item is a much longer list item that describes a change in detail and should be wrapped properly',
        '',
        '| File | Change |',
        '|------|--------|',
        '| foo.js | Added a very long description of the change that was made to this file |',
        '',
        '---',
        '',
        'Another paragraph of prose that wraps. This one also has enough text to trigger wrapping at forty characters.'
      ].join('\n')

      const result = wrapText(input, 40)
      const lines = result.split('\n')

      // Header preserved
      assert.equal(lines[0], '# Session Summary')

      // Code block preserved verbatim
      const codeIdx = lines.indexOf('```js')
      assert.ok(codeIdx > 0)
      assert.equal(lines[codeIdx + 1], 'const result = someFunction(argument1, argument2, argument3, argument4)')

      // Table rows preserved
      assert.ok(lines.some(l => l.startsWith('| File')))
      assert.ok(lines.some(l => l.startsWith('|---')))

      // Separator preserved
      assert.ok(lines.includes('---'))

      // Prose lines should be within limit
      // (skip blank lines, code blocks, tables, headers, separators, list continuations)
      let inCode = false
      for (const line of lines) {
        if (/^`{3,}/.test(line)) { inCode = !inCode; continue }
        if (inCode) continue
        if (line === '') continue
        if (/^#{1,6}\s/.test(line)) continue
        if (/^\|/.test(line.trimStart())) continue
        if (/^[-*_]{3,}\s*$/.test(line)) continue
        // Prose and list items should be within limit
        assert.ok(line.length <= 40, `line exceeds limit: "${line}" (${line.length})`)
      }
    })
  })
})
