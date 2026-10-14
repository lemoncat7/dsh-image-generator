import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { MAX_RESPONSE_BYTES, SETTINGS_REQUEST_HEADER } from './protocol.js'

export function trusted(request: { headers: IncomingHttpHeaders; socket?: { remoteAddress?: string | undefined } }, mutation: boolean): boolean {
  const host = single(request.headers, 'host'); if (host === undefined) return false
  if (Array.isArray(request.headers.origin) || Array.isArray(request.headers['sec-fetch-site'])) return false
  if (single(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = single(request.headers, 'origin')
  if (origin === undefined) {
    if (!mutation) return true
    // Desktop validates dsh-app://app, then strips browser origin metadata.
    // This non-simple header is a CSRF guard, not authentication: the host
    // still authenticates its forwarding cookie. Never trust X-Forwarded-*.
    if (request.headers['sec-fetch-site'] !== undefined || single(request.headers, SETTINGS_REQUEST_HEADER) !== '1') return false
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress ?? '')) return false
    try {
      const target = new URL(`http://${host}`)
      return target.host === host.toLowerCase() && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
        && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash
    } catch { return false }
  }
  try {
    const source = new URL(origin)
    return ['http:', 'https:'].includes(source.protocol) && source.origin === origin && source.host === new URL(`http://${host}`).host
  } catch { return false }
}

export async function body(request: IncomingMessage, maximum = 32 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) { const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += value.length; if (size > maximum) throw new Error('请求内容过大'); chunks.push(value) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function responseBytes(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) throw new Error('图片超过 32 MB 限制')
  const value = Buffer.from(await response.arrayBuffer())
  if (value.length > MAX_RESPONSE_BYTES) throw new Error('图片超过 32 MB 限制')
  return value
}

export function json(response: ServerResponse, status: number, value: unknown): void {
  const output = JSON.stringify(value)
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(output), 'x-content-type-options': 'nosniff' }); response.end(output)
}

export function errorMessage(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function single(headers: IncomingHttpHeaders, key: string): string | undefined { const value = headers[key]; return typeof value === 'string' ? value : undefined }
