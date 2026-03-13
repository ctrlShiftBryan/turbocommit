const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { loadJson, mergeConfig } = require('./io')
const { parseTranscript, formatBody, formatTitleTranscript, extractHeadline, extractModel, isHookFeedback, truncateHookFeedback } = require('./transcript')
const { runTitleAgent, runBodyAgent, runCondenseAgent } = require('./agent')
const { gitRoot, hasChanges, addAndCommit, hasCommits, currentBranch, hasRemote, push } = require('./git')
const { logEvent } = require('./log')
const { wrapText } = require('./wrap')
const { hasTrackedModifications, cleanupTracking } = require('./track')
const { getAncestors, savePending, collectPending, cleanupConsumed, cleanupStale, readWatermark, saveWatermark, resolveParentCommit, saveRefineManifest } = require('./session')

const PENDING_TAG = '[tc-pending]'

/**
 * Map a model ID like "claude-opus-4-6" to a friendly name like "Claude Opus 4.6".
 * Handles both new (claude-opus-4-6) and old (claude-3-5-sonnet-20241022) formats
 * by separating parts into alphabetic (tier) and numeric (version) groups.
 */
function formatModelName (modelId) {
  if (!modelId) return null
  const stripped = modelId.replace(/^claude-/, '')
  if (stripped === modelId) return modelId // not a claude model, use as-is
  const withoutDate = stripped.replace(/-\d{8}$/, '')
  const parts = withoutDate.split('-')
  const alpha = parts.filter(p => /^[a-z]+$/i.test(p))
  const numeric = parts.filter(p => /^\d+$/.test(p))
  if (alpha.length === 0 || numeric.length === 0) return modelId
  const tier = alpha.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  const version = numeric.join('.')
  return `Claude ${tier} ${version}`
}

/**
 * Read Claude Code's attribution.commit setting.
 * Returns the string value (including empty string for explicit opt-out),
 * or undefined when the setting is absent / not running under Claude Code.
 */
function readClaudeAttribution (root) {
  if (!process.env.CLAUDECODE) return undefined
  const globalSettings = loadJson(path.join(os.homedir(), '.claude', 'settings.json'))
  const projectSettings = root ? loadJson(path.join(root, '.claude', 'settings.json')) : null
  const projectVal = projectSettings?.attribution?.commit
  const globalVal = globalSettings?.attribution?.commit
  if (projectVal !== undefined) return projectVal
  if (globalVal !== undefined) return globalVal
  return undefined
}

/**
 * Resolve the Co-Authored-By trailer value.
 * Returns the full trailer line or null.
 *
 * Tier 1: turbocommit config (coauthor: false → null, string → use it)
 * Tier 2: Claude Code attribution.commit setting (when running under Claude)
 * Tier 3: auto-detect model from transcript
 */
function resolveCoauthor (config, transcriptPath, root) {
  // Tier 1: explicit turbocommit config (default: no trailer)
  if (config.coauthor === false || config.coauthor === undefined) return null

  if (typeof config.coauthor === 'string') {
    return `Co-Authored-By: ${config.coauthor}`
  }

  // Tier 2: Claude Code attribution setting
  const claudeAttr = readClaudeAttribution(root)
  if (claudeAttr !== undefined) {
    return claudeAttr === '' ? null : claudeAttr
  }

  // Tier 3: auto-detect from transcript
  const model = extractModel(transcriptPath)
  if (!model) return null
  const name = formatModelName(model)
  return `Co-Authored-By: ${name} <noreply@anthropic.com>`
}

/**
 * Condense verbose hook feedback in pairs via a summarizer agent.
 * Mutates pairs in place.
 */
function condensePairs (root, config, pairs) {
  const condenseCfg = config.condense || {}
  const minLength = condenseCfg.minLength || 200
  for (const pair of pairs) {
    if (!isHookFeedback(pair.prompt) || pair.prompt.length < minLength) continue
    const summary = runCondenseAgent(root, condenseCfg, pair.prompt)
    pair.prompt = summary || truncateHookFeedback(pair.prompt)
  }
}

/**
 * Core auto-commit logic. Called by `turbocommit hook stop`.
 * Reads hook input, checks bail conditions, and commits.
 * Always exits 0 — never blocks Claude, never outputs to stdout.
 *
 * Skip/commit decision is based on PreToolUse tracking:
 * - If tracking file exists with entries → this agent modified files → commit
 * - If tracking file missing/empty → skip, buffer transcript for later pickup
 */
function run (input) {
  if (process.env.TURBOCOMMIT_DISABLED) return

  let hookInput
  try {
    hookInput = JSON.parse(input)
  } catch {
    return
  }

  // Find git root
  const root = gitRoot()
  if (!root) return

  // Merge global + project config (project wins)
  const globalCfg = loadJson(path.join(os.homedir(), '.claude', 'turbocommit.json'))
  const projectCfg = loadJson(`${root}/.claude/turbocommit.json`)
  const config = mergeConfig(globalCfg || {}, projectCfg || {})
  if (config.enabled !== true) return

  // Parse transcript
  const pairs = parseTranscript(hookInput.transcript_path)

  // Gather monitor metadata
  const project = path.basename(root)
  const branch = currentBranch(root)
  let context = 0
  try { context = fs.statSync(hookInput.transcript_path).size } catch {}

  const sessionId = hookInput.session_id

  // Watermark slicing: only include new pairs since last commit in this session
  const watermark = sessionId ? readWatermark(root, sessionId) : null
  const newPairs = watermark ? pairs.slice(watermark.pairs) : pairs
  const effectivePairs = newPairs.length > 0 ? newPairs : pairs

  // Skip decision: if PreToolUse never fired for this session, skip commit
  if (sessionId && !hasTrackedModifications(root, sessionId)) {
    savePending(root, sessionId, formatBody(effectivePairs))
    logEvent('skip', { project, branch, context })
    cleanupStale(root)
    return
  }

  try {
    // Early exit: tracking fired but all changes were reverted
    if (hasCommits(root) && !hasChanges(root)) {
      if (sessionId) {
        savePending(root, sessionId, formatBody(effectivePairs))
        cleanupTracking(root, sessionId)
      }
      logEvent('skip', { project, branch, context })
      cleanupStale(root)
      return
    }

    logEvent('start', { project, branch, context })

    // Resolve continuation + pending (instant, no LLM)
    let continuation = ''
    let pendingSections = []
    if (sessionId) {
      const parentCommit = resolveParentCommit(root, sessionId)
      continuation = parentCommit
        ? `Continuation of ${parentCommit.slice(0, 7)}\n\n`
        : ''
      const ancestors = getAncestors(root, sessionId)
      pendingSections = collectPending(root, [...ancestors].reverse())
    }

    // Resolve coauthor trailer (instant, no LLM)
    const coauthor = resolveCoauthor(config, hookInput.transcript_path, root)
    const coauthorTag = coauthor ? '\n\n' + coauthor : ''

    const mode = config.mode || 'async'

    if (mode !== 'sync') {
      // ── Async path: fast commit, background refine ──
      const headline = extractHeadline(effectivePairs)
      const formattedTranscript = formatBody(effectivePairs)

      let combinedBody = PENDING_TAG + '\n\n' + formattedTranscript
      if (pendingSections.length > 0) {
        combinedBody = PENDING_TAG + '\n\n' + continuation +
          '## Planning\n\n' + pendingSections.join('\n\n---\n\n') +
          '\n\n## Implementation\n\n' + formattedTranscript
      } else {
        combinedBody = PENDING_TAG + '\n\n' + continuation + formattedTranscript
      }

      const wrappedBody = wrapText(combinedBody, config.body?.maxLineLength)
      const sha = addAndCommit(root, headline, wrappedBody + coauthorTag)

      logEvent('fast-commit', { project, branch, context, title: headline })

      if (sessionId) {
        saveWatermark(root, sessionId, pairs.length, sha)
      }

      // Save manifest for phase 2
      const manifestPath = saveRefineManifest(root, sha, {
        root,
        sha,
        sessionId,
        config,
        effectivePairs,
        continuation,
        pendingSections,
        coauthor,
        pairCount: pairs.length,
        branch
      })

      // Spawn detached background refine process
      spawnRefine(manifestPath)

      // Post-commit cleanup
      if (sessionId) {
        const ancestors = getAncestors(root, sessionId)
        cleanupConsumed(root, [...ancestors, sessionId])
        cleanupTracking(root, sessionId)
      }
      cleanupStale(root)
    } else {
      // ── Sync path: original blocking behavior ──
      if (config.condense?.enabled !== false) {
        condensePairs(root, config, effectivePairs)
      }

      const formattedTranscript = formatBody(effectivePairs)

      let headline
      if (config.title?.type !== 'transcript') {
        const titleTranscript = formatTitleTranscript(effectivePairs)
        headline = runTitleAgent(root, config.title || {}, titleTranscript)
      }
      headline = headline || extractHeadline(effectivePairs)

      let body
      if (config.body?.type !== 'transcript') {
        body = runBodyAgent(root, config.body || {}, formattedTranscript)
      }
      body = body || formattedTranscript

      let combinedBody = body
      if (pendingSections.length > 0) {
        combinedBody = continuation + '## Planning\n\n' +
          pendingSections.join('\n\n---\n\n') +
          '\n\n## Implementation\n\n' + body
      } else {
        combinedBody = continuation + body
      }

      const wrappedBody = wrapText(combinedBody, config.body?.maxLineLength)
      const sha = addAndCommit(root, headline, wrappedBody + coauthorTag)

      if (config.autoPush && hasRemote(root)) {
        try {
          push(root)
        } catch {
          logEvent('push-fail', { project, branch })
        }
      }

      logEvent('success', { project, branch, context, title: headline })

      if (sessionId) {
        saveWatermark(root, sessionId, pairs.length, sha)
        const ancestors = getAncestors(root, sessionId)
        cleanupConsumed(root, [...ancestors, sessionId])
        cleanupTracking(root, sessionId)
      }
      cleanupStale(root)
    }
  } catch (err) {
    logEvent('fail', { project, branch, context })
    throw err
  }
}

/**
 * Spawn a detached background process to refine a pending commit.
 */
function spawnRefine (manifestPath) {
  const cliPath = path.join(__dirname, '..', 'cli.js')
  const child = spawn(process.execPath, [cliPath, 'hook', 'refine', manifestPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TURBOCOMMIT_DISABLED: '1' }
  })
  child.unref()
}

module.exports = { run, formatModelName, resolveCoauthor, readClaudeAttribution, condensePairs, spawnRefine, PENDING_TAG }
