import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,rm,writeFile,symlink,stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {imageGenerationTool} from '../lib/tool.js'
import {beginImageDiagnostic} from '../lib/diagnostics.js'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNAAAAABJRU5ErkJggg==','base64')
async function fixture(t){const cwd=await mkdtemp(join(tmpdir(),'image-record-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old});const tool=imageGenerationTool({config:()=>({baseURL:'https://fixture.invalid/v1',model:'fixture-model',requestTimeoutMs:5000}),apiKey:async()=> 'PRIVATE-KEY-NOT-FOR-LOGS'});const exec={callId:'call-test',agent:{session:{header:{cwd}}},signal:new AbortController().signal};return {cwd,tool,exec}}
test('provider failure records exact prompt, ordered reference hashes and HTTP error without credentials',async t=>{
 const {cwd,tool,exec}=await fixture(t);await writeFile(join(cwd,'ref.png'),png);let calls=0
 globalThis.fetch=async(_url,options)=>{calls++;assert.equal(options.body.get('prompt'),'scene only');assert.equal(options.body.getAll('image[]').length,1);return new Response(JSON.stringify({error:{message:'fixture policy rejection',code:'fixture_code',type:'invalid_request_error'}}),{status:400,headers:{'x-request-id':'req-fixture'}})}
 let error;try{await tool.execute({prompt:'scene only',referenceImages:['ref.png']},exec)}catch(e){error=e}
 assert.match(error.message,/fixture policy rejection/);assert.match(error.message,/生图诊断记录/);assert.equal(calls,1)
 const names=await readdir(join(cwd,'.image-generation/attempts'));assert.equal(names.length,1)
 const path=join(cwd,'.image-generation/attempts',names[0]),raw=await readFile(path,'utf8'),d=JSON.parse(raw)
 assert.equal(d.status,'failed');assert.equal(d.httpStatus,400);assert.equal(d.prompt,'scene only');assert.equal(d.callId,'call-test');assert.equal(d.error.requestId,'req-fixture');assert.equal(d.references[0].path,join(cwd,'ref.png'));assert.equal(d.references[0].sha256.length,64);assert.equal(d.files.length,0);assert.ok(!raw.includes('PRIVATE-KEY'));assert.equal((await stat(path)).mode&0o777,0o600)
})
test('success remains an image result with readable record; diagnostic failure never blocks generation',async t=>{
 const {cwd,tool,exec}=await fixture(t);globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}),{status:200})
 const result=JSON.parse(await tool.execute({prompt:'plain shape'},exec));assert.equal(result.files.length,1);assert.equal(JSON.parse(await readFile(result.diagnosticPath,'utf8')).status,'succeeded')
 await rm(join(cwd,'.image-generation'),{recursive:true});await writeFile(join(cwd,'.image-generation'),'blocked')
 const next=JSON.parse(await tool.execute({prompt:'another shape'},exec));assert.equal(next.files.length,1);assert.equal(next.diagnosticPath,undefined)
})
test('invalid reference is recorded without making a provider call',async t=>{
 const {cwd,tool,exec}=await fixture(t);globalThis.fetch=()=>assert.fail('no network')
 await assert.rejects(tool.execute({prompt:'scene',referenceImages:['missing.png']},exec),/生图诊断记录/)
 const [name]=await readdir(join(cwd,'.image-generation/attempts'));const d=JSON.parse(await readFile(join(cwd,'.image-generation/attempts',name),'utf8'));assert.equal(d.status,'failed');assert.equal(d.httpStatus,undefined)
})
test('bounded history keeps running attempts and unrelated files, rejects directory symlink escapes',async t=>{
 const {cwd}=await fixture(t);const running=await beginImageDiagnostic(cwd,{prompt:'running'})
 for(let n=0;n<52;n++){const d=await beginImageDiagnostic(cwd,{prompt:String(n)});await d.finish({status:'failed'})}
 const dir=join(cwd,'.image-generation/attempts');assert.equal((await readdir(dir)).length,51);assert.equal(JSON.parse(await readFile(running.path,'utf8')).status,'running');await running.finish({status:'succeeded'})
 assert.equal((await readdir(dir)).length,50)
 const outside=await mkdtemp(join(tmpdir(),'image-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));await rm(join(cwd,'.image-generation'),{recursive:true});await symlink(outside,join(cwd,'.image-generation'))
 assert.equal(await beginImageDiagnostic(cwd,{prompt:'escape'}),undefined);assert.deepEqual(await readdir(outside),[])
})
