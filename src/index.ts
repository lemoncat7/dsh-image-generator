import type { Context, Volatile } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { body, errorMessage, json, trusted } from './http.js'
import {
  API_KEY_REFERENCE, API_PREFIX, normalizeBaseURL, type PublicConfig,
} from './protocol.js'
import { imageGenerationTool } from './tool.js'

export { validateGenerateInput } from './tool.js'

export const name = 'lemoncat7-image-generator'
export const inject = ['credentials', 'settings', 'tools']
export const SETTINGS_NAMESPACE = 'lemoncat7-image-generator'

export interface Config { readonly baseURL?: string; readonly model?: string; readonly requestTimeoutMs?: number }
export const Config = z.object({
  baseURL: z.string().default('https://api.openai.com/v1'),
  model: z.string().default('gpt-image-1'),
  requestTimeoutMs: z.number().min(10_000).max(600_000).step(1_000).default(180_000),
}).volatile()

interface RuntimeConfig { baseURL: string; model: string; requestTimeoutMs: number }
type RuntimeContext = Context & { settings: SettingsForms }

export function resolveConfig(value: Config): RuntimeConfig {
  const baseURL = normalizeBaseURL(value.baseURL ?? 'https://api.openai.com/v1').toString().replace(/\/$/, '')
  const model = value.model?.trim() ?? 'gpt-image-1'
  if (model.length === 0 || model.length > 200) throw new TypeError('模型名称长度必须为 1 到 200 个字符')
  const requestTimeoutMs = value.requestTimeoutMs ?? 180_000
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 10_000 || requestTimeoutMs > 600_000) throw new TypeError('超时时间必须在 10 到 600 秒之间')
  return { baseURL, model, requestTimeoutMs }
}

export function apply(context: Context, initial: Volatile<Config>): void {
  const ctx = context as RuntimeContext
  const active = (): RuntimeConfig => resolveConfig(initial.get())
  active()
  ctx.effect(() => ctx.settings.configure({ auto: false }))

  const apiKey = async (): Promise<string | undefined> => (await ctx.credentials.resolve(credentialRef(API_KEY_REFERENCE)))?.value
  ctx.effect(() => ctx.tools.register(imageGenerationTool({ config: active, apiKey })), 'image-generator: tool')

  ctx.inject(['webServer', 'settings'], injectedCtx => {
    const webCtx = injectedCtx as RuntimeContext & typeof injectedCtx
    const snapshot = async (): Promise<PublicConfig> => ({ ...active(), keyConfigured: (await apiKey()) !== undefined })
    webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path: `${API_PREFIX}/settings`, handler: async (request, response) => {
      await settingsRoute(request, response, {
        snapshot,
        save: async (config, apiKey) => {
          const next = resolveConfig(config)
          await webCtx.settings.update(SETTINGS_NAMESPACE, next)
          if (apiKey?.trim()) await webCtx.credentials.set(credentialRef(API_KEY_REFERENCE), apiKey.trim())
          return snapshot()
        },
        test: async (config, candidateKey) => testConnection(resolveConfig(config), candidateKey?.trim() || await apiKey()),
      })
    }}), 'image-generator: settings route')
  })
}

interface SettingsApi {
  snapshot(): Promise<PublicConfig>
  save(config: Config, key?: string): Promise<PublicConfig>
  test(config: Config, key?: string): Promise<{ durationMs: number }>
}

async function settingsRoute(request: IncomingMessage, response: ServerResponse, api: SettingsApi): Promise<void> {
  try {
    if (request.method === 'GET') { if (!trusted(request, false)) return json(response, 403, { error: 'forbidden' }); return json(response, 200, await api.snapshot()) }
    if (request.method !== 'PUT' && request.method !== 'POST') return json(response, 405, { error: 'method not allowed' })
    if (!trusted(request, true)) return json(response, 403, { error: 'forbidden' })
    const input = await body(request) as { config?: Config; apiKey?: string }
    if (input.config === undefined || typeof input.config !== 'object') throw new Error('缺少配置')
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 8_192)) throw new Error('API Key 格式无效')
    return json(response, 200, request.method === 'PUT' ? await api.save(input.config, input.apiKey) : await api.test(input.config, input.apiKey))
  } catch (reason) { return json(response, 400, { error: errorMessage(reason) }) }
}

async function testConnection(config: RuntimeConfig, apiKey: string | undefined): Promise<{ durationMs: number }> {
  if (apiKey === undefined) throw new Error('请输入或保存 API Key')
  const endpoint = new URL(`models/${encodeURIComponent(config.model)}`, normalizeBaseURL(config.baseURL))
  const started = Date.now(); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(config.requestTimeoutMs, 30_000))
  try {
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, signal: controller.signal })
    if (!response.ok && response.status !== 404 && response.status !== 405) {
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined
      throw new Error(payload?.error?.message ?? `连接测试返回 HTTP ${response.status}`)
    }
    return { durationMs: Date.now() - started }
  } finally { clearTimeout(timer) }
}
