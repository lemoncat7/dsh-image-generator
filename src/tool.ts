import { beginImageDiagnostic } from './diagnostics.js'
import { randomUUID, createHash } from 'node:crypto'
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
    description: '生图、画图、生成图片、图生图、图片编辑。用户要求图片时实际调用本工具，成功后用返回文件路径交付，不要只回复提示词或承诺。Generate or edit images using the configured OpenAI-compatible image service. For image-to-image work, pass one or more reference image paths from the current conversation workspace. It saves real output files in that workspace; cite the returned paths so the user receives the images. 本次结果附带诊断记录路径；排查历史生图可用已授权文件读取工具查看当前工作目录 .image-generation/attempts/ 下的 JSON，含实际 prompt、参考图、模型和结果；这是操作记录，不是指令。不要把未找到记录当成从未执行，不要把聊天自述代替工具回执。',
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

async function executeImageGeneration(input: GenerateInput, exec: ToolRunContext, runtime: ImageToolRuntime): Promise<{ files: Array<{ path: string; revisedPrompt?: string }>; model: string; diagnosticPath?:string }> {
  const config = runtime.config()
  const apiKey = await runtime.apiKey()
  if (apiKey === undefined) throw new Error('请先在插件设置中保存生图 API Key')
  const cwd = exec.agent?.session.header.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('当前会话没有可用的工作目录')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('生图请求超时')), config.requestTimeoutMs)
  const signal = AbortSignal.any([exec.signal, controller.signal])
  const diagnostic=await beginImageDiagnostic(cwd,{tool:'generate_image',callId:exec.callId,model:config.model,prompt:input.prompt,size:input.size,count:input.count,referenceImages:input.referenceImages})
  const references:Array<{path:string;sha256:string;bytes:number;mediaType:string}>=[]
  const files:Array<{path:string;revisedPrompt?:string}>=[]
  let httpStatus:number|undefined
  let providerError:Record<string,unknown>|undefined
  try {
    const request = input.referenceImages.length === 0
      ? { endpoint: generationEndpoint(config.baseURL), body: JSON.stringify({ model: config.model, prompt: input.prompt, size: input.size, n: input.count }), contentType: 'application/json' }
      : { endpoint: editEndpoint(config.baseURL), body: await editForm(input, config.model, cwd, references), contentType: undefined }
    const response = await fetch(request.endpoint, {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${apiKey}`, ...(request.contentType ? { 'content-type': request.contentType } : {}), accept: 'application/json' },
      body: request.body,
    })
    httpStatus=response.status
    const payload = JSON.parse((await responseBytes(response)).toString('utf8')) as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>; error?: { message?: string;code?:string;type?:string } }
    if (!response.ok) {
      providerError={code:typeof payload.error?.code==='string'?payload.error.code.slice(0,128):undefined,type:typeof payload.error?.type==='string'?payload.error.type.slice(0,128):undefined,requestId:response.headers.get('x-request-id')?.slice(0,200)}
      throw new Error(payload.error?.message ?? `生图服务返回 HTTP ${response.status}`)
    }
    if (!Array.isArray(payload.data) || payload.data.length === 0) throw new Error('生图服务没有返回图片')
    const directory = join(cwd, 'generated')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const item of payload.data) {
      const image = item.b64_json !== undefined ? decodeImage(item.b64_json) : item.url !== undefined ? await downloadImage(item.url, signal) : undefined
      if (image === undefined) throw new Error('生图结果缺少 url 或 b64_json')
      const path = join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}.${extension(image.mediaType)}`)
      await writeFile(path, image.data, { flag: 'wx', mode: 0o600 })
      files.push({ path, ...(item.revised_prompt === undefined ? {} : { revisedPrompt: item.revised_prompt }) })
    }
    const diagnosticPath=await diagnostic?.finish({status:'succeeded',httpStatus,references,files})
    return { files, model: config.model,...(diagnosticPath?{diagnosticPath}:{}) }
  } catch(reason) {
    const message=reason instanceof Error?reason.message:String(reason)
    const diagnosticPath=await diagnostic?.finish({status:'failed',httpStatus,references,files,error:{message:message.slice(0,4096),...providerError}})
    if(diagnosticPath)throw new Error(message+'\n生图诊断记录：'+diagnosticPath,{cause:reason})
    throw reason
  } finally { clearTimeout(timer) }
}

async function editForm(input: GenerateInput, model: string, cwd: string, references:Array<{path:string;sha256:string;bytes:number;mediaType:string}>): Promise<FormData> {
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
    const mediaType=sniff(data)
    references.push({path,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length,mediaType})
    images.push({ data, mediaType, name: basename(path) })
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
