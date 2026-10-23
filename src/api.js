/**
 * QQ OpenAPI calls: gateway discovery and message delivery.
 *
 * Everything goes through `fetch`; no SDK. Business failures arrive as
 * `{ code, err_code, trace_id }` bodies, sometimes with HTTP 200, so the
 * caller must read `code` rather than trust the status line.
 *
 * @module @lanlinju/dsh-qqbot-chat/api
 */

/** A send attempt failed; `errCode` drives the delivery fallback chain. */
export class ApiError extends Error {
  constructor(message, { status, code, errCode, traceId }) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.errCode = errCode
    this.traceId = traceId
  }
}

/** Create the API client for one bot identity. */
export function createApi({ apiBase, tokens, logger, logFrames, trace = () => {} }) {
  async function call(method, path, body, { retryAuth = true } = {}) {
    const token = await tokens.get()
    const started = Date.now()
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = text === '' ? {} : JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
    const elapsed = Date.now() - started
    const code = parsed.code
    const errCode = parsed.err_code ?? parsed.code
    const failed = response.status >= 400 || (typeof code === 'number' && code !== 0)

    if (logFrames) logger.debug(`${method} ${path} -> ${response.status} ${elapsed}ms ${text.slice(0, 800)}`)
    else logger.info(`${method} ${path} -> ${response.status} ${elapsed}ms`)
    trace(`${method} ${path} -> ${response.status}${failed ? ` code=${errCode}` : ''}`)

    if (response.status === 401 && retryAuth) {
      logger.warn(`${method} ${path} rejected the access token; refreshing once`)
      tokens.invalidate()
      return call(method, path, body, { retryAuth: false })
    }
    if (failed) {
      logger.warn(`${method} ${path} failed: code=${code ?? '?'} err_code=${errCode ?? '?'} trace_id=${parsed.trace_id ?? '?'}`)
      throw new ApiError(parsed.message ?? parsed.msg ?? `HTTP ${response.status}`, {
        status: response.status,
        code,
        errCode,
        traceId: parsed.trace_id,
      })
    }
    return parsed
  }

  /** Ask for the gateway address, shard hint, and session-start quota. */
  async function getGateway() {
    const body = await call('GET', '/gateway/bot')
    if (typeof body.url !== 'string' || body.url === '') throw new Error('gateway response carried no url')
    return body
  }

  /**
   * Send one message chunk.
   * @param {{scene: 'c2c'|'group', targetId: string, text: string, markdown: boolean,
   *          msgId?: string, msgSeq?: number}} request - one chunk to deliver.
   */
  async function sendMessage({ scene, targetId, text, markdown, msgId, msgSeq }) {
    const path =
      scene === 'group'
        ? `/v2/groups/${encodeURIComponent(targetId)}/messages`
        : `/v2/users/${encodeURIComponent(targetId)}/messages`
    const body = markdown
      ? { msg_type: 2, markdown: { content: text }, content: '' }
      : { msg_type: 0, content: text }
    if (msgId !== undefined) {
      body.msg_id = msgId
      body.msg_seq = msgSeq ?? 1
    }
    return call('POST', path, body)
  }

  return { getGateway, sendMessage }
}
