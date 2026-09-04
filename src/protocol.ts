export const API_PREFIX = '/lemoncat7-image-generator/v1'
export const API_KEY_REFERENCE = 'OPENAI_IMAGE_API_KEY'
export const MAX_PROMPT_LENGTH = 8_000
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

export interface PublicConfig { baseURL: string; model: string; requestTimeoutMs: number; keyConfigured: boolean }
export interface GenerateInput { prompt: string; size: string; count: number; referenceImages: string[] }

export function normalizeBaseURL(value: string): URL {
  const url = new URL(value.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('URL 必须使用 HTTP 或 HTTPS')
  if (url.username !== '' || url.password !== '') throw new TypeError('URL 不能包含账号或密码')
  url.hash = ''; url.search = ''
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url
}

export function generationEndpoint(baseURL: string): URL {
  return new URL('images/generations', normalizeBaseURL(baseURL))
}

export function editEndpoint(baseURL: string): URL {
  return new URL('images/edits', normalizeBaseURL(baseURL))
}
