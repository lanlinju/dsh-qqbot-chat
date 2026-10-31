/**
 * Inbound rich media: QQ hands us signed URLs in `attachments[]`, dsh wants
 * durable attachment references. This module is the bridge between the two.
 *
 * @module @lanlinju/dsh-qqbot-chat/media
 */

/** Download guard: QQ images are up to 20 MB, but a hung CDN must not block a turn. */
const FETCH_TIMEOUT_MS = 20_000

/** QQ reports `image/jpg` for some uploads; dsh only accepts the canonical name. */
function normalizeMediaType(contentType) {
  const base = String(contentType ?? '').toLowerCase().split(';')[0].trim()
  if (base === 'image/jpg') return 'image/jpeg'
  return base
}

/** Human-readable size; QQ images range from a few KB to 20 MB. */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Turn QQ attachments into dsh image blocks.
 *
 * Every failure degrades to a text note instead of failing the turn: a user who
 * sent a 30 MB PNG should still get an answer explaining why it was skipped.
 *
 * @returns `{blocks, notes}` — image content blocks plus human-readable skips.
 */
export async function ingestImages({ attachments, raw, logger, trace }) {
  const limits = attachments.imageLimits
  const candidates = (Array.isArray(raw) ? raw : []).filter(
    (item) => typeof item?.url === 'string' && normalizeMediaType(item.content_type).startsWith('image/'),
  )
  if (candidates.length === 0) return { blocks: [], notes: [] }

  const notes = []
  // Filter by media type first: an unsupported image must not eat a slot.
  const supported = []
  for (const item of candidates) {
    const mediaType = normalizeMediaType(item.content_type)
    if (!limits.mediaTypes.includes(mediaType)) {
      notes.push(`（有一张图片格式不受支持：${mediaType}）`)
      continue
    }
    supported.push({ ...item, mediaType })
  }
  if (supported.length > limits.maxImagesPerMessage) {
    notes.push(`（一次最多看 ${limits.maxImagesPerMessage} 张图片，其余跳过了）`)
  }

  const blocks = []
  for (const item of supported.slice(0, limits.maxImagesPerMessage)) {
    if (typeof item.size === 'number' && item.size > limits.maxImageBytes) {
      notes.push(`（有一张图片太大：${formatSize(item.size)}）`)
      continue
    }
    try {
      const response = await fetch(item.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.byteLength > limits.maxImageBytes) {
        notes.push(`（有一张图片太大：${formatSize(data.byteLength)}）`)
        continue
      }
      const reference = await attachments.saveImage({
        data,
        mediaType: item.mediaType,
        ...(typeof item.filename === 'string' && item.filename !== '' ? { name: item.filename } : {}),
      })
      blocks.push({ type: 'image', attachment: reference })
      trace(`image ingested: ${item.mediaType} ${data.byteLength}B`)
    } catch (error) {
      logger.warn(`could not ingest an image attachment: ${error.message}`)
      notes.push('（有一张图片没能读取）')
    }
  }
  return { blocks, notes }
}
