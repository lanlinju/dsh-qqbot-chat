/**
 * The bridge: one QQ conversation maps to one dsh Session, turns are queued per
 * conversation, and a finished turn is handed to the replier.
 *
 * Session identity is `c2c:<openid>` or `group:<group_openid>`; both live in
 * memory only, so a dsh restart starts every conversation fresh.
 *
 * @module @lanlinju/dsh-qqbot-chat/bridge
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { composeTurnText } from './reply.js'

/** Expand a leading `~` without touching the fs service. */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Last assistant text plus the turn outcome, mirroring `dsh-headless`. */
function summarize(session, firstSeq) {
  let started = false
  let text = ''
  let reason
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** A counting semaphore so `maxConcurrent` turns can overlap across conversations. */
function createSemaphore(limit) {
  let active = 0
  /** @type {Array<() => void>} */
  const waiting = []
  async function acquire() {
    if (active < limit) {
      active += 1
      return
    }
    await new Promise((resolve) => waiting.push(resolve))
    active += 1
  }
  function release() {
    active -= 1
    const next = waiting.shift()
    if (next !== undefined) next()
  }
  return {
    async run(task) {
      await acquire()
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}

/** Create the bridge between gateway events and dsh sessions. */
export function createBridge({ ctx, config, replier, logger }) {
  const conversations = new Map()
  const semaphore = createSemaphore(config.maxConcurrent)
  const workspacePath = expandHome(config.workspacePath)
  let workspace
  let workspacePending

  async function ensureWorkspace() {
    if (workspace !== undefined) return workspace
    if (workspacePending === undefined) {
      workspacePending = ctx.workspaceRegistry
        .create(workspacePath)
        .then((created) => {
          workspace = created
          logger.info(`workspace ready at ${created.path}`)
          return created
        })
        .finally(() => {
          workspacePending = undefined
        })
    }
    return workspacePending
  }

  function isAllowed(scene, id) {
    const list = scene === 'group' ? config.allowedGroups : config.allowedUsers
    if (list.length === 0) return true
    return list.includes(id)
  }

  /** Create the Session for one conversation and pin its permission tier. */
  async function createConversation(key, scene, targetId) {
    const ws = await ensureWorkspace()
    const sessionId = brandString(`qqbot-${randomUUID()}`)
    const selection = ctx.agentDefaultModel.currentSelection()
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: ws.path },
      agentOptions: { provider: selection.provider, model: selection.model },
    })
    setSandboxMode(agent.session, 'workspace-write')
    setApprovalPolicy(agent.session, 'never')
    try {
      await ws.attachSession(sessionId)
    } catch (error) {
      logger.warn(`could not attach ${sessionId} to the workspace sidebar: ${error.message}`)
    }
    ctx.sessionTitle.rename(agent.session, `QQ-${targetId.slice(-6)}`)
    const entry = { key, scene, targetId, sessionId, agent, chain: Promise.resolve() }
    conversations.set(key, entry)
    logger.info(`session ${sessionId} created for ${key}`)
    return entry
  }

  async function getConversation(key, scene, targetId) {
    const existing = conversations.get(key)
    if (existing !== undefined) return existing
    return createConversation(key, scene, targetId)
  }

  /** Run one turn and deliver its answer. */
  async function runTurn(entry, prompt, msgId) {
    const firstSeq = entry.agent.session.seq
    let acked = false
    let ackTimer
    if (config.ackDelayMs > 0) {
      ackTimer = setTimeout(() => {
        acked = true
        replier.sendAck({ scene: entry.scene, targetId: entry.targetId, msgId }).catch((error) => logger.warn(error.message))
      }, config.ackDelayMs)
      ackTimer.unref?.()
    }
    let reason
    let text = ''
    try {
      entry.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await entry.agent.whenIdle()
    } catch (error) {
      logger.error(error)
      reason = { kind: 'error' }
    } finally {
      if (ackTimer !== undefined) clearTimeout(ackTimer)
    }
    try {
      const outcome = summarize(entry.agent.session, firstSeq)
      text = outcome.text
      reason = outcome.reason ?? reason
    } catch (error) {
      logger.error(error)
    }
    try {
      await ctx.sessions.flush(entry.agent.session)
    } catch (error) {
      logger.warn(`session flush failed: ${error.message}`)
    }
    const composed = composeTurnText(text, reason)
    const outcome = await replier.deliver({
      scene: entry.scene,
      targetId: entry.targetId,
      msgId,
      text: composed,
    })
    logger.info(`turn ${reason?.kind ?? 'unknown'} for ${entry.key}: ${outcome}${acked ? ' (after placeholder)' : ''}`)
  }

  /** Queue work behind whatever this conversation is already running. */
  function enqueue(entry, task) {
    entry.chain = entry.chain
      .then(() => semaphore.run(task))
      .catch((error) => logger.error(error))
    return entry.chain
  }

  /** Handle one `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` event. */
  function handleMessage(type, data) {
    const scene = type === 'GROUP_AT_MESSAGE_CREATE' ? 'group' : 'c2c'
    const targetId = scene === 'group' ? data?.group_openid : data?.author?.user_openid
    const sender = data?.author?.member_openid ?? data?.author?.user_openid ?? 'unknown'
    const msgId = data?.id
    const content = typeof data?.content === 'string' ? data.content.trim() : ''
    if (typeof targetId !== 'string' || targetId === '') {
      logger.warn(`dropped ${type} without a target id`)
      return
    }
    if (msgId === undefined) {
      logger.warn(`dropped ${type} without msg_id`)
      return
    }
    if (content === '') {
      logger.debug(`ignored an empty ${type} from ${sender}`)
      return
    }
    if (!isAllowed(scene, targetId)) {
      logger.warn(`refused ${scene} ${targetId} (not in the allow list); sender openid=${sender}`)
      replier
        .deliver({ scene, targetId, msgId, text: '这个会话不在白名单里。' })
        .catch((error) => logger.error(error))
      return
    }
    const key = scene === 'group' ? `group:${targetId}` : `c2c:${targetId}`
    const prompt = scene === 'group' ? `[成员 ${sender.slice(-6)}] ${content}` : content

    if (content === '/new') {
      conversations.delete(key)
      replier
        .deliver({ scene, targetId, msgId, text: '已开启新会话。' })
        .catch((error) => logger.error(error))
      logger.info(`session for ${key} reset by /new`)
      return
    }

    getConversation(key, scene, targetId)
      .then((entry) => enqueue(entry, () => runTurn(entry, prompt, msgId)))
      .catch((error) => logger.error(error))
  }

  /** Entry point for every dispatch frame the gateway hands us. */
  function onEvent(type, data) {
    if (type === 'C2C_MESSAGE_CREATE' || type === 'GROUP_AT_MESSAGE_CREATE') {
      handleMessage(type, data)
      return
    }
    logger.debug(`ignored gateway event ${type}`)
  }

  return { onEvent, conversations }
}
