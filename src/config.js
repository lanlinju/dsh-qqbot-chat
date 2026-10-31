/**
 * Plugin configuration: field table plus a hand-written Standard Schema
 * validator.
 *
 * Cordis only requires `Config["~standard"].validate` (see
 * `cordis/lib/index.js`: `if (!runtime.Config) return config;` then
 * `runtime.Config["~standard"].validate(config)`), so schemastery is not
 * needed and the runtime stays dependency-free. Validation must be
 * synchronous — `resolveConfig` throws on a thenable.
 *
 * @module @lanlinju/dsh-qqbot-chat/config
 */

const DEFAULT_INTENTS = 1 << 25

/** Field table: `required` plus a coercion/default pair. */
const FIELDS = {
  // Optional here on purpose: `apply` also accepts QQ_BOT_APP_ID from the
  // environment, so a bundle install needs no config at all.
  appId: { kind: 'string' },
  appSecretRef: { kind: 'string', default: 'QQ_BOT_APP_SECRET' },
  intents: { kind: 'int', default: DEFAULT_INTENTS },
  workspacePath: { kind: 'string', default: '~/.dsh/qqbot-workspace' },
  maxConcurrent: { kind: 'int', default: 1, min: 1 },
  apiBase: { kind: 'string', default: 'https://api.bot.qq.com' },
  logFrames: { kind: 'boolean', default: false },
  allowedUsers: { kind: 'string[]', default: [] },
  allowedGroups: { kind: 'string[]', default: [] },
  ackDelayMs: { kind: 'int', default: 8000, min: 0 },
  maxChars: { kind: 'int', default: 1500, min: 200 },
  maxChunks: { kind: 'int', default: 4, min: 1 },
  format: { kind: 'enum', values: ['markdown', 'text'], default: 'markdown' },
  replyStyle: { kind: 'enum', values: ['none', 'at', 'quote'], default: 'none' },
  /**
   * Which group messages start a turn. `all` answers every human message in the
   * group (one model call each); `mention` answers only an @-mention.
   */
  groupReply: { kind: 'enum', values: ['mention', 'all'], default: 'all' },
}

/** Describe a value the way a config author would recognise it. */
function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Coerce one field, pushing a located issue on failure. */
function coerce(name, spec, raw, issues) {
  const path = [name]
  if (raw === undefined) {
    if (spec.required) issues.push({ message: `${name} is required`, path })
    return spec.default
  }
  switch (spec.kind) {
    case 'string':
      if (typeof raw !== 'string') {
        issues.push({ message: `${name} must be a string, got ${describe(raw)}`, path })
        return undefined
      }
      if (raw.trim() === '') {
        issues.push({ message: `${name} must not be blank`, path })
        return undefined
      }
      return raw
    case 'int': {
      const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (spec.min ?? 0)) {
        issues.push({ message: `${name} must be an integer >= ${spec.min ?? 0}, got ${JSON.stringify(raw)}`, path })
        return undefined
      }
      return value
    }
    case 'boolean':
      if (typeof raw !== 'boolean') {
        issues.push({ message: `${name} must be a boolean, got ${describe(raw)}`, path })
        return undefined
      }
      return raw
    case 'enum':
      if (!spec.values.includes(raw)) {
        issues.push({ message: `${name} must be one of ${spec.values.join(' | ')}, got ${JSON.stringify(raw)}`, path })
        return undefined
      }
      return raw
    case 'string[]': {
      const list = typeof raw === 'string' ? raw.split(',').map((item) => item.trim()).filter(Boolean) : raw
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
        issues.push({ message: `${name} must be an array of strings`, path })
        return undefined
      }
      return list.filter((item) => item !== '')
    }
    default:
      issues.push({ message: `${name} has an unknown field kind`, path })
      return undefined
  }
}

/** Validate one raw config object into the normalised shape. */
export function validate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { issues: [{ message: `config must be an object, got ${describe(raw)}` }] }
  }
  const issues = []
  const value = {}
  for (const [name, spec] of Object.entries(FIELDS)) {
    const next = coerce(name, spec, raw[name], issues)
    if (next !== undefined) value[name] = next
  }
  for (const name of Object.keys(raw)) {
    if (!(name in FIELDS)) issues.push({ message: `${name} is not a known field`, path: [name] })
  }
  return issues.length === 0 ? { value } : { issues }
}

/** Standard Schema surface consumed by the cordis loader. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-qqbot-chat',
    validate,
  },
}
