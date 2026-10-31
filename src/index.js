/**
 * Assembly only: wire the token provider, API client, replier, bridge, and
 * gateway together and hand the socket's lifetime to the fiber.
 *
 * @module @lanlinju/dsh-qqbot-chat
 */

import { Config } from './config.js'
import { createTokenProvider } from './token.js'
import { createApi } from './api.js'
import { createGateway } from './gateway.js'
import { createReplier } from './reply.js'
import { createBridge } from './bridge.js'

/** Stable cordis plugin name. */
export const name = 'qqbot-chat'

/** Services the bridge needs before it can create a Session. */
export const inject = [
  'agents',
  'sessions',
  'agentDefaultModel',
  'agentPresets',
  'attachments',
  'workspaceRegistry',
  'sessionTitle',
  'credentials',
]

export { Config }

/**
 * Mount the channel.
 * @param ctx - plugin context carrying the injected services.
 * @param config - normalised configuration from `Config`.
 */
export async function apply(ctx, config) {
  const logger = ctx.logger
  const trace =
    process.env.DSH_QQBOT_DEBUG === '1' ? (message) => console.error(`[qqbot] ${message}`) : () => {}
  trace('apply called')
  trace(`groupReply=${config.groupReply} ackDelayMs=${config.ackDelayMs} format=${config.format}`)

  const appId = config.appId ?? process.env.QQ_BOT_APP_ID
  if (typeof appId !== 'string' || appId.trim() === '') {
    throw new Error(
      'qqbot-chat needs the bot AppID: set `appId` in the plugin config, or export QQ_BOT_APP_ID before starting dsh',
    )
  }

  const tokens = createTokenProvider({
    apiBase: config.apiBase,
    appId,
    appSecretRef: config.appSecretRef,
    credentials: ctx.credentials,
    logger,
  })

  const api = createApi({ apiBase: config.apiBase, tokens, logger, logFrames: config.logFrames, trace })
  const replier = createReplier({ api, logger, config, awaitReady: (ms) => gateway.awaitReady(ms) })
  const bridge = createBridge({ ctx, config, replier, logger, trace })

  const gateway = createGateway({
    api,
    tokens,
    intents: config.intents,
    logger,
    logFrames: config.logFrames,
    trace,
    onEvent: (type, data) => bridge.onEvent(type, data),
  })

  ctx.effect(() => {
    logger.info(`qqbot-chat mounting: appId=${appId} intents=${config.intents} workspace=${config.workspacePath}`)
    trace('effect running, starting gateway')
    gateway.start()
    return () => gateway.stop()
  })
}
