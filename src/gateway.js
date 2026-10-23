/**
 * Gateway socket: connect, identify or resume, heartbeat, and route the close
 * code to the right recovery.
 *
 * The gateway speaks plain JSON text frames — no compression is documented —
 * so a binary frame is only ever decoded defensively.
 *
 * @module @lanlinju/dsh-qqbot-chat/gateway
 */

/** Close codes that mean "resume is still legal". */
const RESUME_CODES = new Set([4009])
/** Close codes that force a fresh identify. */
const IDENTIFY_CODES = new Set([4006, 4007])
/** Unrecoverable: stop reconnecting entirely. */
const FATAL_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915])

/** Exponential backoff with a ceiling; #9 will refine the curve. */
function backoffMs(attempt) {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5))
  return base + Math.floor(Math.random() * 250)
}

/** Whether a close code means "identify again" rather than "resume". */
function classify(code, hasSession) {
  if (FATAL_CODES.has(code)) return 'stop'
  if (RESUME_CODES.has(code)) return hasSession ? 'resume' : 'identify'
  if (IDENTIFY_CODES.has(code) || (code >= 4900 && code <= 4913)) return 'identify'
  return hasSession ? 'resume' : 'identify'
}

/** Create the gateway connection manager. */
export function createGateway({ api, tokens, intents, logger, logFrames, trace = () => {}, onEvent }) {
  let socket
  let stopping = false
  let sessionId
  let seq
  let heartbeatTimer
  let reconnectTimer
  let attempt = 0
  let ready = false
  /** Last `session_start_limit` reading: remaining sessions today and when the window resets. */
  let startLimit
  /** @type {Array<() => void>} */
  let readyWaiters = []

  const isReady = () => ready

  function markReady() {
    ready = true
    attempt = 0
    const waiters = readyWaiters
    readyWaiters = []
    for (const resolve of waiters) resolve()
  }

  function markNotReady() {
    ready = false
  }

  /** Resolve once the gateway is READY, or after `timeoutMs`. */
  function awaitReady(timeoutMs) {
    if (ready) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        readyWaiters = readyWaiters.filter((waiter) => waiter !== onReady)
        resolve(false)
      }, timeoutMs)
      function onReady() {
        clearTimeout(timer)
        resolve(true)
      }
      readyWaiters.push(onReady)
    })
  }

  function clearHeartbeat() {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  function send(payload) {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(payload))
    return true
  }

  function startHeartbeat(intervalMs) {
    clearHeartbeat()
    const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 45_000
    heartbeatTimer = setInterval(() => {
      if (!send({ op: 1, d: seq ?? null })) clearHeartbeat()
    }, period)
    heartbeatTimer.unref?.()
  }

  async function identifyOrResume() {
    const token = `QQBot ${await tokens.get()}`
    if (sessionId !== undefined && seq !== undefined) {
      logger.info(`resuming gateway session ${sessionId} at seq ${seq}`)
      send({ op: 6, d: { token, session_id: sessionId, seq } })
      return
    }
    logger.info(`identifying with intents=${intents}`)
    send({
      op: 2,
      d: {
        token,
        intents,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: 'dsh-qqbot-chat', $device: 'dsh-qqbot-chat' },
      },
    })
  }

  function handleDispatch(type, data) {
    if (type === 'READY') {
      sessionId = data?.session_id
      markReady()
      logger.info(`gateway READY session=${sessionId ?? '?'}`)
      return
    }
    if (type === 'RESUMED') {
      markReady()
      logger.info('gateway RESUMED')
      return
    }
    try {
      onEvent(type, data)
    } catch (error) {
      logger.error(error)
    }
  }

  function handleFrame(raw) {
    let frame
    try {
      frame = JSON.parse(raw)
    } catch {
      logger.warn(`dropped a non-JSON gateway frame: ${String(raw).slice(0, 200)}`)
      return
    }
    if (typeof frame.s === 'number') {
      if (frame.op === 0 && seq !== undefined && frame.s > seq + 1) {
        logger.warn(`gateway sequence jumped ${seq} -> ${frame.s}; ${frame.s - seq - 1} event(s) were missed`)
      }
      seq = frame.s
    }
    trace(`<- op=${frame.op}${frame.t === undefined ? '' : ` t=${frame.t}`}${frame.op === 9 ? ' (invalid session)' : ''}`)
    switch (frame.op) {
      case 0:
        handleDispatch(frame.t, frame.d)
        return
      case 1:
        send({ op: 1, d: seq ?? null })
        return
      case 7:
        logger.warn('gateway asked us to reconnect')
        socket?.close(4009, 'server requested reconnect')
        return
      case 9:
        logger.warn('gateway invalidated the session; identifying again')
        sessionId = undefined
        seq = undefined
        markNotReady()
        socket?.close(4006, 'invalid session')
        return
      case 10:
        startHeartbeat(frame.d?.heartbeat_interval)
        identifyOrResume().catch((error) => {
          logger.error(error)
          trace('identify failed, closing the socket so the reconnect loop owns the retry')
          socket?.close(4009, 'identify failed')
        })
        return
      case 11:
        return
      default:
        logger.debug(`ignored gateway op=${frame.op}`)
    }
  }

  function scheduleReconnect(action) {
    if (stopping) return
    if (action === 'stop') {
      logger.error(new Error('gateway reported an unrecoverable close; the channel is offline until dsh restarts'))
      return
    }
    if (action === 'identify') {
      sessionId = undefined
      seq = undefined
    }
    attempt += 1
    let delay = backoffMs(attempt)
    if (startLimit !== undefined) {
      if (startLimit.remaining <= 0) {
        delay = Math.max(delay, Math.min(startLimit.resetAfterMs, 3_600_000) + 1_000)
        logger.error(
          new Error(
            `daily session-start quota exhausted; holding reconnect for ${Math.round(delay / 1000)}s until the window resets`,
          ),
        )
      } else if (startLimit.remaining < 10) {
        delay = Math.max(delay, 60_000)
        logger.warn(`only ${startLimit.remaining} session starts left today; backing off ${Math.round(delay / 1000)}s`)
      }
    }
    logger.warn(`gateway closed; reconnecting in ${delay}ms (attempt ${attempt}, ${action})`)
    trace(`reconnect in ${delay}ms (attempt ${attempt}, ${action})`)
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, delay)
    reconnectTimer.unref?.()
  }

  async function connect() {
    if (stopping) return
    markNotReady()
    let url
    try {
      trace('requesting gateway url')
      const gateway = await api.getGateway()
      url = gateway.url
      trace(`gateway url ${url}`)
      const limit = gateway.session_start_limit
      if (limit !== undefined && typeof limit.remaining === 'number') {
        startLimit = {
          remaining: limit.remaining,
          resetAfterMs: (Number(limit.reset_after) || 0) * 1000,
        }
        trace(`session_start_limit remaining=${startLimit.remaining} reset_after=${limit.reset_after ?? '?'}s`)
      }
    } catch (error) {
      trace(`gateway url failed: ${error.message}`)
      logger.error(error)
      scheduleReconnect('identify')
      return
    }
    if (stopping) return
    let next
    try {
      next = new WebSocket(url)
    } catch (error) {
      logger.error(error)
      scheduleReconnect('identify')
      return
    }
    socket = next
    next.binaryType = 'arraybuffer'

    next.addEventListener('open', () => {
      trace('socket open, waiting for hello')
    })

    next.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        if (logFrames) logger.debug(`<- ${event.data.slice(0, 800)}`)
        handleFrame(event.data)
        return
      }
      try {
        const text = new TextDecoder().decode(event.data)
        if (logFrames) logger.debug(`<- (binary) ${text.slice(0, 800)}`)
        handleFrame(text)
      } catch (error) {
        logger.warn(`dropped an undecodable binary frame: ${String(error)}`)
      }
    })

    next.addEventListener('error', () => {
      logger.warn('gateway socket error')
    })

    next.addEventListener('close', (event) => {
      clearHeartbeat()
      markNotReady()
      trace(`socket closed code=${event.code} reason=${event.reason}`)
      if (stopping) return
      if (socket === next) socket = undefined
      scheduleReconnect(classify(event.code, sessionId !== undefined && seq !== undefined))
    })
  }

  /** Start connecting; resolves immediately, failures retry in the background. */
  function start() {
    stopping = false
    connect()
  }

  /** Close the socket and stop reconnecting; resolves once the socket is down. */
  async function stop() {
    trace('dispose requested')
    stopping = true
    clearHeartbeat()
    clearTimeout(reconnectTimer)
    markNotReady()
    const current = socket
    socket = undefined
    if (current === undefined || current.readyState === WebSocket.CLOSED) return
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000)
      current.addEventListener('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        current.close(1000, 'plugin disposing')
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    logger.info('gateway closed')
    trace('gateway closed')
  }

  return { start, stop, isReady, awaitReady }
}
