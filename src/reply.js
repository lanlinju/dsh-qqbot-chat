/**
 * Turning one finished turn into QQ messages: normalise, split, and deliver
 * passive-first with an error-driven fallback.
 *
 * Passive replies are the only path that is guaranteed to arrive, so we never
 * abandon them on a local clock — the server's error code decides. See
 * `docs/adr/0002-passive-first-error-driven-fallback.md`.
 *
 * @module @lanlinju/dsh-qqbot-chat/reply
 */

/** The reply window or its quota is gone for this `msg_id`. */
const WINDOW_DEAD = new Set([40034005, 304103, 304027, 40034128, 40034024])
/** Content exceeded the platform limit. */
const TOO_LONG = new Set([40054007, 40054018])
/** Active push refused: rate limit, no permission, or the user opted out. */
const ACTIVE_BLOCKED = new Set([40034100, 40034105, 40054013])
/** Markdown the platform will not render. */
const MARKDOWN_REJECTED = new Set([40034011, 40034008, 40034009, 40034124])
/** Same `msg_id + msg_seq` sent twice. */
const DUPLICATE = 40054005
/** Gateway not ready yet. */
const NO_SESSION = 304018

/** Appended when content had to be cut. Never carries a URL (`40054010`). */
export const TRUNCATED_FOOTER = '（内容过长已截断，完整内容在 dsh Web UI 的这个会话里）'

/** Per-scene passive reply quota for one `msg_id`. */
const PASSIVE_BUDGET = { c2c: 4, group: 5 }

/** Split points, best first. */
const SOFT_BREAKS = ['\n\n', '\n', '。', '！', '？', '；', '.', '!', '?', ';', '，', ',', ' ']

/** Strip what QQ's markdown renderer chokes on, remembering code lines. */
export function normalize(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept = []
  const isCode = []
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    const isRow = /^\s*\|.*\|\s*$/.test(line)
    kept.push(
      isRow
        ? line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()).join(' | ')
        : line,
    )
    isCode.push(fenced)
    const next = lines[index + 1]
    if (isRow && next !== undefined && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(next)) index += 1
  }
  return { text: kept.join('\n'), isCode }
}

/** Cut `text` into at most `maxChunks` pieces of roughly `maxChars`. */
export function splitText(text, maxChars, maxChunks) {
  if (text.length <= maxChars) return [text]
  const chunks = []
  let rest = text
  while (rest.length > maxChars && chunks.length < maxChunks) {
    let cut = -1
    for (const marker of SOFT_BREAKS) {
      const index = rest.lastIndexOf(marker, maxChars)
      if (index > maxChars * 0.4) {
        cut = index + marker.length
        break
      }
    }
    if (cut === -1) cut = maxChars
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== '') {
    if (chunks.length < maxChunks) chunks.push(rest)
    else chunks[chunks.length - 1] += `\n${TRUNCATED_FOOTER}`
  }
  return chunks
}

/** Copy for a turn that ended without a normal answer. */
function reasonText(reason) {
  switch (reason?.kind) {
    case 'error':
      return '这一轮跑挂了。'
    case 'max-tokens':
      return '（输出被截断）'
    case 'aborted':
      return '已中止。'
    case 'interrupted':
      return '上一轮被中断了。'
    case 'blocked':
      return '这一轮被拦下了（需要审批或权限不足）。'
    default:
      return '（本轮没有产出文本）'
  }
}

/**
 * Lines carrying model-side tool-call syntax. A Session without tools makes the
 * model emit its native template (`<||DSML||invoke ...>`) as plain text; that
 * must never reach a QQ user.
 */
const PROTOCOL_MARKUP = /DSML|<\/?(?:function_calls|invoke|parameter)\b/i

/** Drop protocol markup lines; fall back when nothing readable is left. */
function scrubProtocolMarkup(text) {
  if (!PROTOCOL_MARKUP.test(text)) return text
  const kept = text.split('\n').filter((line) => !PROTOCOL_MARKUP.test(line))
  const cleaned = kept.join('\n').trim()
  return cleaned === '' ? '（这一轮没有产出可展示的内容）' : cleaned
}

/** Compose the final text for one turn from the assistant text and turn end. */
export function composeTurnText(text, reason) {
  const body = scrubProtocolMarkup(text.trim())
  if (reason?.kind === 'completed') return body === '' ? reasonText(reason) : body
  if (reason?.kind === 'max-tokens') return body === '' ? reasonText(reason) : `${body}\n\n${reasonText(reason)}`
  return body === '' ? reasonText(reason) : `${body}\n\n${reasonText(reason)}`
}

/** Create the delivery engine. */
export function createReplier({ api, logger, config, awaitReady }) {
  /** Sticky for the process: once the platform says "too long", never grow back. */
  let maxChars = config.maxChars
  /**
   * `msg_seq` is per `msg_id` and must strictly increase across every message we
   * send for that inbound message — the placeholder and the answer share the
   * counter, otherwise the answer is rejected as a duplicate of the placeholder.
   * @type {Map<string, number>}
   */
  const seqByMsgId = new Map()

  function nextSeq(msgId) {
    if (msgId === undefined) return undefined
    const next = seqByMsgId.get(msgId) ?? 1
    seqByMsgId.set(msgId, next + 1)
    return next
  }

  /** Drop the counter once a turn is finished, keeping the map bounded. */
  function forgetMsgId(msgId) {
    if (msgId !== undefined) seqByMsgId.delete(msgId)
    if (seqByMsgId.size > 500) seqByMsgId.clear()
  }

  async function sendOnce({ scene, targetId, text, markdown, msgId, msgSeq }) {
    return api.sendMessage({ scene, targetId, text, markdown, msgId, msgSeq })
  }

  /**
   * Deliver one already-composed text.
   * @param {{scene: string, targetId: string, msgId?: string, text: string, ackSent?: boolean}} request
   * @returns {Promise<'sent'|'partial'|'failed'>}
   */
  async function deliver({ scene, targetId, msgId, text, ackSent = false }) {
    const markdown = config.format === 'markdown'
    const normalized = markdown ? normalize(text) : { text, isCode: [] }
    let passiveAlive = true
    let budget = (PASSIVE_BUDGET[scene] ?? 4) - (ackSent ? 1 : 0)
    let activeMarkdown = markdown
    let delivered = 0

    const limit = Math.max(1, Math.min(config.maxChunks, budget))
    const queue = splitText(normalized.text, maxChars, limit)

    while (queue.length > 0) {
      const chunk = queue.shift()
      let attempts = 0
      for (;;) {
        attempts += 1
        if (attempts > 6) {
          logger.error(new Error(`giving up on a chunk after ${attempts} attempts (${chunk.length} chars)`))
          return delivered === 0 ? 'failed' : 'partial'
        }
        const usePassive = passiveAlive && budget > 0 && msgId !== undefined
        try {
          await sendOnce({
            scene,
            targetId,
            text: chunk,
            markdown: activeMarkdown,
            ...(usePassive ? { msgId, msgSeq: nextSeq(msgId) } : {}),
          })
          if (usePassive) budget -= 1
          delivered += 1
          break
        } catch (error) {
          const errCode = error.errCode
          if (errCode === DUPLICATE && usePassive) continue
          if (WINDOW_DEAD.has(errCode) && usePassive) {
            passiveAlive = false
            logger.warn(`passive window closed (err_code=${errCode}); switching this turn to active push`)
            continue
          }
          if (TOO_LONG.has(errCode)) {
            maxChars = Math.max(200, Math.floor(maxChars / 2))
            logger.warn(`content too long (err_code=${errCode}); maxChars now ${maxChars}`)
            queue.unshift(...splitText(chunk, maxChars, Number.MAX_SAFE_INTEGER))
            break
          }
          if (MARKDOWN_REJECTED.has(errCode) && activeMarkdown) {
            activeMarkdown = false
            logger.warn(`markdown rejected (err_code=${errCode}); resending this chunk as plain text`)
            continue
          }
          if (errCode === NO_SESSION && attempts === 1) {
            const ok = await awaitReady(5_000)
            logger.warn(`gateway not ready (err_code=${errCode}); ${ok ? 'retrying' : 'retry window elapsed'}`)
            if (ok) continue
          }
          if (ACTIVE_BLOCKED.has(errCode) && !usePassive) {
            logger.error(new Error(`active push refused (err_code=${errCode}); this turn cannot be delivered`))
            return delivered === 0 ? 'failed' : 'partial'
          }
          logger.error(error)
          return delivered === 0 ? 'failed' : 'partial'
        }
      }
    }
    return 'sent'
  }

  /** Send the one placeholder allowed per turn; reports whether it landed. */
  async function sendAck({ scene, targetId, msgId }) {
    if (config.ackDelayMs === 0) return false
    const text = '收到，正在处理…'
    try {
      await sendOnce({
        scene,
        targetId,
        text,
        markdown: false,
        ...(msgId === undefined ? {} : { msgId, msgSeq: nextSeq(msgId) }),
      })
      return true
    } catch (error) {
      logger.warn(`placeholder not delivered: ${error.message}`)
      return false
    }
  }

  return { deliver, sendAck, forgetMsgId }
}
