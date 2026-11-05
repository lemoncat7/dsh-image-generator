import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {ToolExecutionPipeline} from '@deepseek-ai/dsh-tools/pipeline'
import {imageGenerationTool} from '../lib/tool.js'

test('0.2.2 pipeline generates and edits images, preserves errors and denies calls before HTTP', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'image-runtime-'))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  const requests = []
  let fail = false
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({path: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString()})
    res.writeHead(fail ? 503 : 200, {'content-type': 'application/json'})
    res.end(JSON.stringify(fail ? {error: {message: 'fixture service unavailable'}} : {data: [{b64_json: png.toString('base64')}]}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const ctx = new Context()
  const prompt = ctx.plugin(SystemPrompt); await prompt
  const runtime = ctx.plugin(ToolRuntime); await runtime
  t.after(async () => {
    await runtime.dispose(); await prompt.dispose()
    await new Promise(resolve => server.close(resolve))
    await rm(cwd, {recursive: true, force: true})
  })
  ctx.tools.register(imageGenerationTool({
    config: () => ({baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture', requestTimeoutMs: 2000}),
    apiKey: async () => 'isolated-fixture',
  }))
  const agent = {session: {id: 'isolated', header: {cwd}}}
  let sequence = 0
  const call = async arguments_ => {
    const pipeline = new ToolExecutionPipeline(ctx)
    const prepared = await pipeline.prepare({name: 'generate_image', arguments: arguments_, agent, signal: new AbortController().signal, callId: `image-${++sequence}`})
    return pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared)
  }
  const output = result => JSON.parse(result.content.find(block => block.type === 'text').text)
  const generated = await call({prompt: 'test'})
  assert.equal(generated.isError, false)
  assert.deepEqual(await readFile(output(generated).files[0].path), png)
  assert.equal(requests[0].path, '/v1/images/generations')
  await writeFile(join(cwd, 'reference.png'), png)
  const edited = await call({prompt: 'edit', referenceImages: ['reference.png']})
  assert.equal(edited.isError, false)
  assert.deepEqual(await readFile(output(edited).files[0].path), png)
  assert.equal(requests[1].path, '/v1/images/edits')
  assert.match(requests[1].type, /multipart\/form-data/)
  assert.match(requests[1].body, /name="image\[\]"; filename="reference.png"/)
  fail = true
  const failed = await call({prompt: 'fail'})
  assert.equal(failed.isError, true)
  assert.match(JSON.stringify(failed.content), /fixture service unavailable/)
  const count = requests.length
  ctx.tools.guard(() => 'fixture denied')
  assert.equal((await call({prompt: 'deny'})).isError, true)
  assert.equal(requests.length, count)
})
