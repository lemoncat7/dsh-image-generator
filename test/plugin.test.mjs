import assert from 'node:assert/strict'
import test from 'node:test'
import { editEndpoint, generationEndpoint, normalizeBaseURL } from '../lib/protocol.js'
import { resolveConfig, validateGenerateInput } from '../lib/index.js'

test('normalizes OpenAI-compatible image endpoints', () => {
  assert.equal(generationEndpoint('https://api.example.com/v1').toString(), 'https://api.example.com/v1/images/generations')
  assert.equal(editEndpoint('https://api.example.com/v1').toString(), 'https://api.example.com/v1/images/edits')
  assert.throws(() => normalizeBaseURL('file:///tmp/api'))
  assert.throws(() => normalizeBaseURL('https://user:secret@example.com/v1'))
})

test('validates configuration and bounded generation input', () => {
  assert.deepEqual(resolveConfig({}), { baseURL: 'https://api.openai.com/v1', model: 'gpt-image-1', requestTimeoutMs: 180000 })
  assert.deepEqual(validateGenerateInput({ prompt: '  一只黑猫  ', size: '1024x1024', count: 1 }), { prompt: '一只黑猫', size: '1024x1024', count: 1, referenceImages: [] })
  assert.deepEqual(validateGenerateInput({ prompt: '参考这些图片', referenceImages: [' a.png ', 'b.webp'] }).referenceImages, ['a.png', 'b.webp'])
  assert.throws(() => validateGenerateInput({ prompt: '', size: '1024x1024', count: 1 }))
  assert.throws(() => validateGenerateInput({ prompt: 'x', size: 'bad', count: 1 }))
  assert.throws(() => validateGenerateInput({ prompt: 'x', size: '1024x1024', count: 5 }))
  assert.throws(() => validateGenerateInput({ prompt: 'x', referenceImages: Array.from({ length: 9 }, (_, index) => `${index}.png`) }))
})

test('client only provides styled plugin settings without a generation workspace', async () => {
  const fs = await import('node:fs/promises')
  const css = await fs.readFile(new URL('../src/client.css', import.meta.url), 'utf8')
  const client = await fs.readFile(new URL('../src/client.tsx', import.meta.url), 'utf8')
  assert.match(css, /appearance:none/)
  assert.match(css, /font-family:-apple-system/)
  assert.match(css, /prefers-reduced-motion:reduce/)
  assert.doesNotMatch(client, /sidebar\.footer\.action/)
  assert.doesNotMatch(client, /function Workspace/)
  assert.match(client, /settings\.plugins\.tab/)
})

test('registers image generation as a conversation tool', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/tool.ts', import.meta.url), 'utf8'))
  assert.match(source, /name: 'generate_image'/)
  assert.match(source, /exec\.agent\?\.session\.header\.cwd/)
  assert.match(source, /writeFile\(path/)
  assert.match(source, /form\.append\('image\[\]'/)
  assert.match(source, /参考图必须位于当前会话工作目录内/)
})
