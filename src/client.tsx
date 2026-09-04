import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { useEffect, useState } from 'react'
import cssText from './client.css'
import { API_PREFIX, type PublicConfig } from './protocol.js'

const STYLE_ID = '@lemoncat7/dsh-image-generator/client'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'image-generator: settings styles')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item', key: 'lemoncat7-image-generator',
  }, SettingsCard))
}

function SettingsCard(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<PublicConfig>()
  const [draft, setDraft] = useState<PublicConfig>()
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'test'>()
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string }>()
  useEffect(() => {
    if (!open || draft !== undefined) return
    void request<PublicConfig>(`${API_PREFIX}/settings`).then(value => {
      setSaved(value); setDraft(value)
    }).catch(reason => setNotice({ kind: 'error', text: message(reason) }))
  }, [draft, open])
  const submit = async (method: 'PUT' | 'POST'): Promise<void> => {
    if (draft === undefined) return
    setBusy(method === 'PUT' ? 'save' : 'test'); setNotice(undefined)
    try {
      const payload = { config: { baseURL: draft.baseURL, model: draft.model, requestTimeoutMs: draft.requestTimeoutMs }, ...(apiKey.trim() ? { apiKey } : {}) }
      const result = await request<PublicConfig | { durationMs: number }>(`${API_PREFIX}/settings`, payload, method)
      if (method === 'PUT') {
        const value = result as PublicConfig
        setSaved(value); setDraft(value); setApiKey(''); setNotice({ kind: 'ok', text: '设置已保存' })
      } else setNotice({ kind: 'ok', text: `连接正常，${(result as { durationMs: number }).durationMs} ms` })
    } catch (reason) { setNotice({ kind: 'error', text: message(reason) }) } finally { setBusy(undefined) }
  }
  const dirty = draft !== undefined && (apiKey.trim() !== '' || draft.baseURL !== saved?.baseURL || draft.model !== saved?.model || draft.requestTimeoutMs !== saved?.requestTimeoutMs)
  return <li className={`dsh-image-settings${open ? ' is-open' : ''}`}>
    <button type="button" className="dsh-image-settings-head" onClick={() => setOpen(value => !value)} aria-expanded={open}><span><strong>生图工具</strong><small>为会话提供 OpenAI 通用协议生图能力</small></span><em>{saved?.keyConfigured ? '已配置' : '未配置'}　⌄</em></button>
    {open && <div className="dsh-image-settings-body">
      {draft === undefined ? <p className="dsh-image-settings-state">正在读取设置…</p> : <>
        <label><span>API URL</span><input value={draft.baseURL} placeholder="https://api.openai.com/v1" onChange={event => setDraft({ ...draft, baseURL: event.target.value })} /><small>填写到 API 版本目录，工具调用 images/generations。</small></label>
        <label><span>API Key</span><input type="password" autoComplete="off" value={apiKey} placeholder={draft.keyConfigured ? '已保存，留空保持不变' : '输入 API Key'} onChange={event => setApiKey(event.target.value)} /></label>
        <label><span>模型</span><input value={draft.model} placeholder="gpt-image-1" onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
        <label><span>超时时间</span><select value={draft.requestTimeoutMs} onChange={event => setDraft({ ...draft, requestTimeoutMs: Number(event.target.value) })}><option value="60000">60 秒</option><option value="120000">120 秒</option><option value="180000">180 秒</option><option value="300000">300 秒</option><option value="600000">600 秒</option></select></label>
        {notice && <p className={`dsh-image-settings-notice is-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
        <footer><button type="button" onClick={() => { void submit('POST') }} disabled={busy !== undefined || draft.baseURL.trim() === '' || draft.model.trim() === ''}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button type="button" className="is-primary" onClick={() => { void submit('PUT') }} disabled={!dirty || busy !== undefined}>{busy === 'save' ? '保存中…' : '保存'}</button></footer>
      </>}
    </div>}
  </li>
}

async function request<T>(url: string, payload?: unknown, method: 'PUT' | 'POST' = 'POST'): Promise<T> {
  const response = await fetch(url, payload === undefined ? { method: 'GET' } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const result = await response.json() as T | { error?: string }
  if (!response.ok) throw new Error(typeof result === 'object' && result !== null && 'error' in result && typeof result.error === 'string' ? result.error : `HTTP ${response.status}`)
  return result as T
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
function installStyles(): () => void {
  document.getElementById(STYLE_ID)?.remove()
  const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = cssText; document.head.append(style)
  return () => style.remove()
}
