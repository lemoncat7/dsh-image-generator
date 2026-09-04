import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'
import { MAX_RESPONSE_BYTES } from './protocol.js'

export function trusted(request: { headers: IncomingHttpHeaders }, mutation: boolean): boolean {
  const host = single(request.headers, 'host'); if (host === undefined) return false
  if (single(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = single(request.headers, 'origin'); if (origin === undefined) return !mutation
  try { return new URL(origin).host === new URL(`http://${host}`).host } catch { return false }
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
