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
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { composeTurnText } from './reply.js'
import { createSessionIndex } from './sessions.js'

/** Where dsh keeps its home; the session index lives beside the sessions themselves. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured !== '') return configured
  return join(homedir(), '.dsh')
}

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
export function createBridge({ ctx, config, replier, logger, trace = () => {} }) {
  const conversations = new Map()
  /** @type {Map<string, Promise<object>>} */
  const creating = new Map()
  const sessionIndex = createSessionIndex({ file: join(dshHome(), 'qqbot-chat', 'sessions.json'), logger })
  if (sessionIndex.size() > 0) logger.info(`session index loaded: ${sessionIndex.size()} conversation(s) remembered`)
  const semaphore = createSemaphore(config.maxConcurrent)
  const workspacePath = expandHome(config.workspacePath)
  let workspace
  let workspacePending

  async function ensureWorkspace() {
    if (workspace !== undefined) return workspace
    if (workspacePending === undefined) {
      workspacePending = mkdir(workspacePath, { recursive: true })
        .then(() => ctx.workspaceRegistry.create(workspacePath))
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

  /** Pin the tier and title that a Session does not carry across a restart. */
  function applySessionPolicy(agent, targetId) {
    setSandboxMode(agent.session, 'workspace-write')
    setApprovalPolicy(agent.session, 'never')
    ctx.sessionTitle.rename(agent.session, `QQ-${targetId.slice(-6)}`)
  }

  /**
   * Compose the per-Agent scope the way the Web UI does.
   *
   * Without mounting an agent preset the Session gets **no tools at all**: the
   * model then writes tool calls as plain text (the DSML template it was
   * trained on) and the turn ends with markup as the answer.
   */
  async function composeAgent(selection) {
    const preset = await ctx.agentPresets.resolve(undefined)
    return {
      agentPreset: preset.id,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined })
        await ctx.agentPresets.mount(agentCtx, preset.id)
      },
    }
  }

  /** Re-attach a Session to the workspace sidebar; failure is cosmetic only. */
  async function attachQuietly(ws, sessionId) {
    try {
      await ws.attachSession(sessionId)
    } catch (error) {
      logger.warn(`could not attach ${sessionId} to the workspace sidebar: ${error.message}`)
    }
  }

  /**
   * Create or resume the Session for one conversation.
   *
   * A remembered Session is only adopted when it was recorded under the same
   * workspace — a changed `workspacePath` means the old cwd is wrong. Any
   * resume failure falls back to a fresh Session without telling the user.
   */
  async function createConversation(key, scene, targetId) {
    const ws = await ensureWorkspace()
    const selection = ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const composition = await composeAgent(selection)
    const remembered = sessionIndex.get(key)

    if (remembered !== undefined) {
      if (remembered.workspacePath !== ws.path) {
        logger.warn(
          `session ${remembered.sessionId} was recorded under ${remembered.workspacePath}, not ${ws.path}; starting a new one for ${key}`,
        )
        sessionIndex.delete(key)
      } else if (remembered.agentPreset !== composition.agentPreset) {
        logger.warn(
          `session ${remembered.sessionId} was composed with preset ${remembered.agentPreset ?? '(none)'}, now ${composition.agentPreset}; starting a new one for ${key}`,
        )
        sessionIndex.delete(key)
      } else {
        // A Session attached to the workspace is reopened by dsh at boot, so it
        // can already be live under a write handle; adopt it instead of trying
        // to resume (which refuses an actively owned Session).
        const live = ctx.agents.get(brandString(remembered.sessionId))
        if (live !== undefined) {
          trace(`adopting already-live session ${remembered.sessionId} for ${key}`)
          applySessionPolicy(live, targetId)
          const entry = { key, scene, targetId, sessionId: remembered.sessionId, agent: live, chain: Promise.resolve() }
          conversations.set(key, entry)
          logger.info(`session ${remembered.sessionId} adopted (already live) for ${key}`)
          return entry
        }
        try {
          const { agent } = await ctx.agents.resume({
            resumeSessionId: brandString(remembered.sessionId),
            agentOptions,
            setup: composition.setup,
          })
          trace(`resumed session ${remembered.sessionId} for ${key}`)
          applySessionPolicy(agent, targetId)
          await attachQuietly(ws, remembered.sessionId)
          const entry = { key, scene, targetId, sessionId: remembered.sessionId, agent, chain: Promise.resolve() }
          conversations.set(key, entry)
          logger.info(`session ${remembered.sessionId} resumed for ${key}`)
          return entry
        } catch (error) {
          trace(`resume failed for ${key}: ${error.message}`)
          logger.warn(`could not resume ${remembered.sessionId} for ${key}: ${error.message}; starting a new session`)
          sessionIndex.delete(key)
        }
      }
    }

    const sessionId = brandString(`qqbot-${randomUUID()}`)
    trace(`creating session for ${key}`)
    const { agent } = await ctx.agents.create({
      sessionId,
      meta: { cwd: ws.path, agentPreset: composition.agentPreset },
      agentOptions,
      setup: composition.setup,
    })
    trace(`agent created ${sessionId}`)
    applySessionPolicy(agent, targetId)
    await attachQuietly(ws, sessionId)
    sessionIndex.set(key, { sessionId, workspacePath: ws.path, agentPreset: composition.agentPreset })
    const entry = { key, scene, targetId, sessionId, agent, chain: Promise.resolve() }
    conversations.set(key, entry)
    logger.info(`session ${sessionId} created for ${key}`)
    return entry
  }

  /** Resolve the conversation, creating it at most once even under a burst. */
  function getConversation(key, scene, targetId) {
    const existing = conversations.get(key)
    if (existing !== undefined) return Promise.resolve(existing)
    const pending = creating.get(key)
    if (pending !== undefined) return pending
    const promise = createConversation(key, scene, targetId).finally(() => {
      creating.delete(key)
    })
    creating.set(key, promise)
    return promise
  }

  /** Run one turn and deliver its answer. */
  async function runTurn(entry, prompt, msgId) {
    const firstSeq = entry.agent.session.seq
    let ackTimer
    let ackFired = false
    let settleAck
    const ackPromise = new Promise((resolve) => {
      settleAck = resolve
    })
    if (config.ackDelayMs > 0) {
      ackTimer = setTimeout(() => {
        ackFired = true
        replier
          .sendAck({ scene: entry.scene, targetId: entry.targetId, msgId })
          .then((sent) => settleAck(sent))
          .catch(() => settleAck(false))
      }, config.ackDelayMs)
      ackTimer.unref?.()
    } else {
      settleAck(false)
    }
    let reason
    let text = ''
    try {
      trace(`turn start (firstSeq=${firstSeq})`)
      entry.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
      await entry.agent.whenIdle()
      trace('whenIdle returned')
    } catch (error) {
      trace(`turn error: ${error?.stack ?? error}`)
      logger.error(error)
      reason = { kind: 'error' }
    } finally {
      if (ackTimer !== undefined) clearTimeout(ackTimer)
      if (!ackFired) settleAck(false)
    }
    const ackSent = await ackPromise
    try {
      const outcome = summarize(entry.agent.session, firstSeq)
      text = outcome.text
      reason = outcome.reason ?? reason
      if (reason?.kind === 'error') {
        trace(`turn failed: ${reason.error?.code ?? '?'} ${reason.error?.message ?? '?'}`)
      }
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
      ackSent,
    })
    replier.forgetMsgId(msgId)
    logger.info(`turn ${reason?.kind ?? 'unknown'} for ${entry.key}: ${outcome}${ackSent ? ' (after placeholder)' : ''}`)
  }

  /** Queue work behind whatever this conversation is already running. */
  function enqueue(entry, task) {
    entry.chain = entry.chain
      .then(() => semaphore.run(task))
      .catch((error) => {
        trace(`queue error: ${error?.stack ?? error}`)
        logger.error(error)
      })
    return entry.chain
  }

  /** Handle one `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` event. */
  function handleMessage(type, data) {
    const scene = type === 'GROUP_AT_MESSAGE_CREATE' ? 'group' : 'c2c'
    const targetId = scene === 'group' ? data?.group_openid : data?.author?.user_openid
    const sender = data?.author?.member_openid ?? data?.author?.user_openid ?? 'unknown'
    const msgId = data?.id
    const content = typeof data?.content === 'string' ? data.content.trim() : ''
    trace(
      `raw ${type} target=${String(targetId)} msgId=${String(msgId)} type=${String(data?.message_type)} content=${JSON.stringify(content)}`,
    )
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
      if (scene === 'group') {
        replier
          .deliver({ scene, targetId, msgId, text: '在的，@我之后直接说需求就行。' })
          .catch((error) => logger.error(error))
      }
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
    trace(`message ${type} key=${key} msgId=${msgId} chars=${content.length}`)

    if (content === '/new') {
      conversations.delete(key)
      sessionIndex.delete(key)
      replier
        .deliver({ scene, targetId, msgId, text: '已开启新会话。' })
        .catch((error) => logger.error(error))
      logger.info(`session for ${key} reset by /new`)
      return
    }

    getConversation(key, scene, targetId)
      .then((entry) => enqueue(entry, () => runTurn(entry, prompt, msgId)))
      .catch((error) => {
        trace(`conversation error: ${error?.stack ?? error}`)
        logger.error(error)
      })
  }

  /** Drop `<@openid>` tokens the platform leaves in full-message payloads. */
  function stripMentionTokens(text) {
    return text.replace(/<@[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  }

  /** Entry point for every dispatch frame the gateway hands us. */
  function onEvent(type, data) {
    if (type === 'C2C_MESSAGE_CREATE' || type === 'GROUP_AT_MESSAGE_CREATE') {
      handleMessage(type, data)
      return
    }
    if (type === 'GROUP_MESSAGE_CREATE') {
      // A bot with full-message access gets every group message here, and an
      // @-mention arrives as this type too — `mentions[].is_you` is the only
      // reliable "was I addressed" signal.
      if (data?.author?.bot === true) {
        trace('ignored a group message authored by a bot (loop guard)')
        return
      }
      const mentions = Array.isArray(data?.mentions) ? data.mentions : []
      const addressed = mentions.some((mention) => mention?.is_you === true) || config.groupReply === 'all'
      if (!addressed) {
        trace(`group message not addressed to the bot (${mentions.length} mention(s)); ignored`)
        return
      }
      handleMessage('GROUP_AT_MESSAGE_CREATE', {
        ...data,
        content: typeof data?.content === 'string' ? stripMentionTokens(data.content) : data?.content,
      })
      return
    }
    logger.debug(`ignored gateway event ${type}`)
  }

  return { onEvent, conversations }
}
