const { tryRun } = require('./io')

const DEFAULT_COMMAND = 'claude -p --model haiku'

const DEFAULT_TITLE_PROMPT = `Given this transcript of a coding session, write a single-line git commit headline (max 72 characters).

Rules:
- Imperative mood ("Add", "Fix", "Update", not "Added", "Fixed")
- Specific about what changed
- No trailing period
- No conventional commit prefixes unless the change is clearly a fix/feat/etc.

Transcript:
{{transcript}}

Respond with ONLY the headline, nothing else.`

const DEFAULT_BODY_PROMPT = `Given this transcript of a coding session, write a concise git commit body.

Rules:
- Summarize what was done and why
- Be concise — a few sentences or bullet points
- Focus on the "why" more than the "what"

Transcript:
{{transcript}}

Respond with ONLY the commit body, nothing else.`

function renderPrompt (template, transcript) {
  return template.replace(/\{\{transcript\}\}/g, () => transcript)
}

function runAgent (root, command, prompt) {
  const binary = command.split(/\s+/)[0]
  const whichResult = tryRun(`which ${binary}`, {})
  if (whichResult.code !== 0) return null

  const result = tryRun(command, {
    cwd: root,
    timeout: 30000,
    input: prompt,
    env: { ...process.env, TURBOCOMMIT_DISABLED: '1', CLAUDECODE: '' }
  })

  if (result.code !== 0) return null

  const output = (result.stdout.trim() || result.stderr.trim())
  return output || null
}

function runTitleAgent (root, titleCfg, transcript) {
  const command = titleCfg.command || DEFAULT_COMMAND
  const template = titleCfg.prompt || DEFAULT_TITLE_PROMPT
  const prompt = renderPrompt(template, transcript)
  const result = runAgent(root, command, prompt)
  if (!result) return null
  // Take only first line and enforce 72 char limit
  return result.split('\n')[0].slice(0, 72) || null
}

function runBodyAgent (root, bodyCfg, transcript) {
  const command = bodyCfg.command || DEFAULT_COMMAND
  const template = bodyCfg.prompt || DEFAULT_BODY_PROMPT
  const prompt = renderPrompt(template, transcript)
  return runAgent(root, command, prompt)
}

module.exports = {
  DEFAULT_COMMAND,
  DEFAULT_TITLE_PROMPT,
  DEFAULT_BODY_PROMPT,
  renderPrompt,
  runAgent,
  runTitleAgent,
  runBodyAgent
}
