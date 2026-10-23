/**
 * `access_token` cache: one credential, two uses (HTTP `Authorization: QQBot
 * <token>` and the gateway `identify.d.token`), refreshed ahead of expiry and
 * coalesced so concurrent callers share one request.
 *
 * The credential is a *reference* — the value lives in `$DSH_HOME/.credentials.yaml`
 * or the environment and is resolved here, per refresh, so rotating it needs no
 * restart.
 *
 * @module @lanlinju/dsh-qqbot-chat/token
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'

/** Refresh this long before the advertised expiry. */
const REFRESH_AHEAD_MS = 60_000

/** Build the token provider for one bot identity. */
export function createTokenProvider({ apiBase, appId, appSecretRef, credentials, logger }) {
  const ref = credentialRef(appSecretRef)
  /** @type {{ token: string, expiresAt: number } | undefined} */
  let cached
  /** @type {Promise<string> | undefined} */
  let inflight

  async function request() {
    const secret = await credentials.resolve(ref)
    if (secret === undefined) {
      throw new Error(`credential "${appSecretRef}" is not configured; put it in $DSH_HOME/.credentials.yaml or export it`)
    }
    const response = await fetch(`${apiBase}/app/getAppAccessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: secret.value }),
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`getAppAccessToken returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`)
    }
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error(`getAppAccessToken failed: code=${body.code ?? '?'} message=${body.message ?? '?'}`)
    }
    const ttlMs = Number(body.expires_in) * 1000
    const lifetime = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 7200_000
    cached = { token: body.access_token, expiresAt: Date.now() + lifetime }
    logger.debug(`token refreshed, lifetime=${Math.round(lifetime / 1000)}s`)
    return cached.token
  }

  /** Resolve a usable token, refreshing when close to expiry. */
  async function get() {
    if (cached !== undefined && cached.expiresAt - REFRESH_AHEAD_MS > Date.now()) return cached.token
    if (inflight !== undefined) return inflight
    inflight = request().finally(() => {
      inflight = undefined
    })
    return inflight
  }

  /** Drop the cached token (e.g. after the gateway rejects it). */
  function invalidate() {
    cached = undefined
  }

  return { get, invalidate }
}
