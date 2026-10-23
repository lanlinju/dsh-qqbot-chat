/**
 * Durable index of `QQ conversation key -> dsh Session id`.
 *
 * Sessions themselves are persisted by dsh under `$DSH_HOME/sessions/`; all
 * that is lost on restart is this pointer. Keeping it outside the workspace is
 * deliberate — the workspace is the agent's own writable directory.
 *
 * Entries also record the agent preset they were composed with: a Session
 * resumed under a different composition arrives with every tool deferred (the
 * provider rejects that), so a mismatch must start a new Session instead.
 *
 * @module @lanlinju/dsh-qqbot-chat/sessions
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const VERSION = 2

/**
 * Open (or create) the index at `file`.
 * @param {{file: string, logger: {warn: Function}}} options - storage location and sink.
 */
export function createSessionIndex({ file, logger }) {
  /** @type {Map<string, {sessionId: string, workspacePath: string, updatedAt: string}>} */
  const entries = new Map()

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed?.version === VERSION && parsed.sessions !== null && typeof parsed.sessions === 'object') {
      for (const [key, value] of Object.entries(parsed.sessions)) {
        if (typeof value?.sessionId === 'string' && value.sessionId !== '') entries.set(key, value)
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`session index at ${file} is unreadable (${error.message}); starting empty`)
  }

  /** Persist through a temp file so a crash cannot leave a half-written index. */
  function flush() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: VERSION, sessions: Object.fromEntries(entries) }, null, 2)}\n`)
      renameSync(temporary, file)
    } catch (error) {
      logger.warn(`could not write the session index at ${file}: ${error.message}`)
    }
  }

  return {
    size: () => entries.size,
    get: (key) => entries.get(key),
    set(key, value) {
      entries.set(key, { ...value, updatedAt: new Date().toISOString() })
      flush()
    },
    delete(key) {
      if (entries.delete(key)) flush()
    },
  }
}
