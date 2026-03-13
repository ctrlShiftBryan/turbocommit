const { readRefineManifest, cleanupRefineManifest, saveWatermark } = require('./session')
const { headSha, amendCommit, hasRemote, push } = require('./git')
const { runTitleAgent, runBodyAgent, runCondenseAgent } = require('./agent')
const { formatBody, formatTitleTranscript, extractHeadline, isHookFeedback, truncateHookFeedback } = require('./transcript')
const { wrapText } = require('./wrap')
const { acquireLock, releaseLock } = require('./lock')
const { logEvent } = require('./log')
const path = require('path')

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
 * Phase 2: background refine. Reads manifest, runs agents, amends commit.
 */
function refine (manifestPath) {
  const manifest = readRefineManifest(manifestPath)
  if (!manifest) return

  const { root, sha, sessionId, config, effectivePairs, continuation,
    pendingSections, coauthor, pairCount } = manifest

  const project = path.basename(root)
  const branch = manifest.branch || 'unknown'

  if (!acquireLock(root, sha)) {
    logEvent('refine-skip', { project, branch, reason: 'lock-timeout' })
    return
  }

  try {
    // Verify HEAD hasn't moved
    const currentHead = headSha(root)
    if (currentHead !== sha) {
      logEvent('refine-skip', { project, branch, reason: 'head-moved' })
      return
    }

    const pairs = effectivePairs

    // Condense hook feedback if enabled
    if (config.condense?.enabled !== false) {
      condensePairs(root, config, pairs)
    }

    const formattedTranscript = formatBody(pairs)

    // Title: agent by default, transcript if opted out
    let headline
    if (config.title?.type !== 'transcript') {
      const titleTranscript = formatTitleTranscript(pairs)
      headline = runTitleAgent(root, config.title || {}, titleTranscript)
    }
    headline = headline || extractHeadline(pairs)

    // Body: agent by default, transcript if opted out
    let body
    if (config.body?.type !== 'transcript') {
      body = runBodyAgent(root, config.body || {}, formattedTranscript)
    }
    body = body || formattedTranscript

    // Rebuild full body with continuation + pending sections
    let combinedBody = body
    if (pendingSections && pendingSections.length > 0) {
      combinedBody = (continuation || '') + '## Planning\n\n' +
        pendingSections.join('\n\n---\n\n') +
        '\n\n## Implementation\n\n' + body
    } else {
      combinedBody = (continuation || '') + body
    }

    const wrappedBody = wrapText(combinedBody, config.body?.maxLineLength)
    const tag = coauthor ? '\n\n' + coauthor : ''

    const newSha = amendCommit(root, headline, wrappedBody + tag)

    if (sessionId) {
      saveWatermark(root, sessionId, pairCount, newSha)
    }

    if (config.autoPush && hasRemote(root)) {
      try {
        push(root)
      } catch {
        logEvent('push-fail', { project, branch })
      }
    }

    logEvent('refine-success', { project, branch, title: headline })
  } catch (err) {
    logEvent('refine-fail', { project, branch })
  } finally {
    cleanupRefineManifest(manifestPath)
    releaseLock(root)
  }
}

module.exports = { refine }
