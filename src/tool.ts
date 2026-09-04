import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { responseBytes } from './http.js'
import { editEndpoint, generationEndpoint, MAX_PROMPT_LENGTH, type GenerateInput } from './protocol.js'

const MAX_REFERENCE_IMAGES = 8
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_TOTAL_BYTES = 64 * 1024 * 1024

export interface ImageToolConfig { baseURL: string; model: string; requestTimeoutMs: number }
export interface ImageToolRuntime {
  config(): ImageToolConfig
  apiKey(): Promise<string | undefined>
}

export function imageGenerationTool(runtime: ImageToolRuntime): ToolDefinition {
  return {
    name: 'generate_image',
    description: 'Generate or edit images using the configured OpenAI-compatible image service. For image-to-image work, pass one or more reference image paths from the current conversation workspace. It saves real output files in that workspace; cite the returned paths so the user receives the images.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: 'Complete image prompt including subject, composition, lighting, and style.' },
        size: { type: 'string', enum: ['auto', '1024x1024', '1536x1024', '1024x1536'], description: 'Output size. Defaults to 1024x1024.' },
        count: { type: 'integer', minimum: 1, maximum: 4, description: 'Number of images. Defaults to 1.' },
        referenceImages: { type: 'array', maxItems: MAX_REFERENCE_IMAGES, items: { type: 'string' }, description: 'Optional 1–8 PNG/JPEG/WebP paths inside the current conversation workspace. Their array order is preserved for multi-reference editing.' },
      },
      required: ['prompt'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: 600_000,
    presentCall: () => ({ card: 'generic', title: '生成图片' }),
    execute: async (raw, exec) => JSON.stringify(await executeImageGeneration(validateGenerateInput(raw), exec, runtime)),
  }
}

export function validateGenerateInput(value: unknown): GenerateInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('请求格式无效')
  const input = value as Partial<GenerateInput>
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) throw new TypeError(`提示词长度必须为 1 到 ${MAX_PROMPT_LENGTH} 个字符`)
  const size = input.size ?? '1024x1024'
  if (!['auto', '1024x1024', '1536x1024', '1024x1536'].includes(size)) throw new TypeError('图片尺寸不受支持')
  const count = input.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new TypeError('生成数量必须为 1 到 4')
  const referenceImages = input.referenceImages ?? []
  if (!Array.isArray(referenceImages) || referenceImages.length > MAX_REFERENCE_IMAGES || referenceImages.some(path => typeof path !== 'string' || path.trim().length === 0 || path.length > 4_096)) throw new TypeError(`参考图必须是最多 ${MAX_REFERENCE_IMAGES} 个有效文件路径`)
  return { prompt, size, count, referenceImages: referenceImages.map(path => path.trim()) }
}

async function executeImageGeneration(input: GenerateInput, exec: ToolRunContext, runtime: ImageToolRuntime): Promise<{ files: Array<{ path: string; revisedPrompt?: string }>; model: string }> {
  const config = runtime.config()
  const apiKey = await runtime.apiKey()
  if (apiKey === undefined) throw new Error('请先在插件设置中保存生图 API Key')
  const cwd = exec.agent?.session.header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('当前会话没有可用的工作目录')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('生图请求超时')), config.requestTimeoutMs)
  const signal = AbortSignal.any([exec.signal, controller.signal])
  try {
    const request = input.referenceImages.length === 0
      ? { endpoint: generationEndpoint(config.baseURL), body: JSON.stringify({ model: config.model, prompt: input.prompt, size: input.size, n: input.count }), contentType: 'application/json' }
      : { endpoint: editEndpoint(config.baseURL), body: await editForm(input, config.model, cwd), contentType: undefined }
    const response = await fetch(request.endpoint, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${apiKey}`, ...(request.contentType ? { 'content-type': request.contentType } : {}), accept: 'application/json' },
      body: request.body,
    })
    const payload = JSON.parse((await responseBytes(response)).toString('utf8')) as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>; error?: { message?: string } }
    if (!response.ok) throw new Error(payload.error?.message ?? `生图服务返回 HTTP ${response.status}`)
    if (!Array.isArray(payload.data) || payload.data.length === 0) throw new Error('生图服务没有返回图片')
    const directory = join(cwd, 'generated')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const files = [] as Array<{ path: string; revisedPrompt?: string }>
    for (const item of payload.data) {
      const image = item.b64_json !== undefined ? decodeImage(item.b64_json) : item.url !== undefined ? await downloadImage(item.url, signal) : undefined
      if (image === undefined) throw new Error('生图结果缺少 url 或 b64_json')
      const path = join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}.${extension(image.mediaType)}`)
      await writeFile(path, image.data, { flag: 'wx', mode: 0o600 })
      files.push({ path, ...(item.revised_prompt === undefined ? {} : { revisedPrompt: item.revised_prompt }) })
    }
    return { files, model: config.model }
  } finally { clearTimeout(timer) }
}

async function editForm(input: GenerateInput, model: string, cwd: string): Promise<FormData> {
  const root = await realpath(cwd)
  const images = [] as Array<{ data: Buffer; mediaType: string; name: string }>
  let totalBytes = 0
  for (const requested of input.referenceImages) {
    const path = await realpath(resolve(root, requested))
    const within = relative(root, path)
    if (within === '..' || within.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(root, within) !== path) throw new Error('参考图必须位于当前会话工作目录内')
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`参考图不是文件：${requested}`)
    if (info.size === 0 || info.size > MAX_REFERENCE_BYTES) throw new Error(`单张参考图必须小于 ${MAX_REFERENCE_BYTES / 1024 / 1024} MB`)
    totalBytes += info.size
    if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) throw new Error(`参考图总大小不能超过 ${MAX_REFERENCE_TOTAL_BYTES / 1024 / 1024} MB`)
    const data = await readFile(path)
    images.push({ data, mediaType: sniff(data), name: basename(path) })
  }
  const form = new FormData()
  form.set('model', model)
  form.set('prompt', input.prompt)
  form.set('size', input.size)
  form.set('n', String(input.count))
  for (const image of images) form.append('image[]', new Blob([Uint8Array.from(image.data)], { type: image.mediaType }), image.name)
  return form
}

function decodeImage(value: string): { data: Buffer; mediaType: string } {
  const data = Buffer.from(value, 'base64')
  if (data.length === 0) throw new Error('生图服务返回了空图片')
  return { data, mediaType: sniff(data) }
}

async function downloadImage(value: string, signal: AbortSignal): Promise<{ data: Buffer; mediaType: string }> {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('图片返回地址不是 HTTP(S) URL')
  const response = await fetch(url, { signal, redirect: 'follow' })
  if (!response.ok) throw new Error(`下载生成图片失败：HTTP ${response.status}`)
  const data = await responseBytes(response)
  return { data, mediaType: sniff(data) }
}

function sniff(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  throw new Error('生图服务返回了不受支持的图片格式')
}

function extension(mediaType: string): string { return mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png' }
