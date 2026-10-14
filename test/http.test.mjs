import assert from 'node:assert/strict'
import test from 'node:test'
import {Readable} from 'node:stream'
import {trusted} from '../lib/http.js'
import {apply} from '../lib/index.js'
import {SETTINGS_REQUEST_HEADER} from '../lib/protocol.js'

const desktopHeaders={host:'127.0.0.1:13280','content-type':'application/json',[SETTINGS_REQUEST_HEADER]:'1'}
const request=(headers,remoteAddress='127.0.0.1')=>({headers,socket:{remoteAddress}})

test('desktop forwarding accepts only loopback requests with the non-simple plugin header',()=>{
 for(const [host,peer] of [['127.0.0.1:13280','127.0.0.1'],['localhost:13280','::ffff:127.0.0.1'],['[::1]:13280','::1']]) {
  assert.equal(trusted(request({...desktopHeaders,host},peer),true),true)
 }
 for(const headers of [
  {host:'127.0.0.1:13280'}, {...desktopHeaders,[SETTINGS_REQUEST_HEADER]:'0'},
  {...desktopHeaders,origin:'https://evil.example'}, {...desktopHeaders,origin:'null'},
  {...desktopHeaders,origin:'dsh-app://app'}, {...desktopHeaders,origin:['http://127.0.0.1:13280']},
  {...desktopHeaders,'sec-fetch-site':'cross-site'}, {...desktopHeaders,'sec-fetch-site':'same-origin'},
  {...desktopHeaders,'sec-fetch-site':['cross-site']}, {...desktopHeaders,host:'rebound.evil:13280'},
  {...desktopHeaders,host:'127.0.0.1:13280/path'}, {...desktopHeaders,host:'user@127.0.0.1:13280'},
  {...desktopHeaders,host:'192.168.1.1:13280'}, {...desktopHeaders,[SETTINGS_REQUEST_HEADER]:['1']},
 ]) assert.equal(trusted(request(headers),true),false,JSON.stringify(headers))
 assert.equal(trusted(request(desktopHeaders,'192.168.1.2'),true),false)
 assert.equal(trusted({headers:desktopHeaders},true),false)
 assert.equal(trusted(request({...desktopHeaders,'x-forwarded-for':'127.0.0.1'},'192.168.1.2'),true),false)
})

test('web same-origin reads and writes keep working; hostile origins stay rejected',()=>{
 for(const mutation of [true,false]) {
  assert.equal(trusted(request({host:'dsh.example:1443',origin:'https://dsh.example:1443'}),mutation),true)
  assert.equal(trusted(request({host:'dsh.example:1443',origin:'https://evil.example',[SETTINGS_REQUEST_HEADER]:'1'}),mutation),false)
  assert.equal(trusted(request({host:'dsh.example',origin:'https://dsh.example','sec-fetch-site':'cross-site'}),mutation),false)
 }
 assert.equal(trusted(request({host:'dsh.example'}),false),true)
 assert.equal(trusted(request({host:'dsh.example'}),true),false)
})

test('registered settings route saves and tests forwarded desktop requests, refuses cross-site before effects',async t=>{
 let handler,config={baseURL:'https://images.example/v1',model:'gpt-image-2.5',requestTimeoutMs:180000},saved=0,tested=0,key
 const ctx={effect:fn=>fn(),inject:(_names,fn)=>fn(ctx),tools:{register:()=>()=>{}},
  settings:{configure:()=>()=>{},update:async(_ns,next)=>{saved++;config=next}},
  credentials:{resolve:async()=>key?{value:key}:undefined,set:async(_ref,value)=>{key=value}},
  webServer:{register:route=>{handler=route.handler;return()=>{}}}}
 apply(ctx,{get:()=>config})
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  tested++;assert.equal(String(url),'https://images.example/v1/models/gpt-image-2.5')
  assert.equal(init.headers.authorization,'Bearer fixture-key')
  return new Response('{}',{status:200})
 })
 const call=async(method,headers=desktopHeaders)=>{
  const req=Object.assign(Readable.from([JSON.stringify({config,apiKey:'fixture-key'})]),request(headers),{method})
  const res={writeHead(status,headers){this.status=status;this.headers=headers},end(data){this.body=JSON.parse(data)}}
  await handler(req,res);return res
 }
 assert.equal((await call('GET',{host:desktopHeaders.host})).status,200)
 for(const method of ['PUT','POST']) {
  assert.equal((await call(method,{host:desktopHeaders.host})).status,403)
  assert.equal((await call(method,{...desktopHeaders,origin:'https://evil.example'})).status,403)
  assert.equal((await call(method,{...desktopHeaders,'sec-fetch-site':'cross-site'})).status,403)
 }
 assert.equal(saved,0);assert.equal(tested,0)
 const save=await call('PUT');assert.equal(save.status,200);assert.equal(save.body.model,'gpt-image-2.5');assert.equal(save.body.keyConfigured,true)
 assert.equal(JSON.stringify(save.body).includes('fixture-key'),false)
 assert.equal((await call('POST')).status,200);assert.equal(saved,1);assert.equal(tested,1)
 const options=await call('OPTIONS');assert.equal(options.status,405)
 assert.equal(options.headers['access-control-allow-origin'],undefined)
})

test('settings client sends the desktop-compatible CSRF header for both mutation methods',async()=>{
 const {readFile}=await import('node:fs/promises')
 const source=await readFile(new URL('../src/client.tsx',import.meta.url),'utf8')
 assert.match(source,/\[SETTINGS_REQUEST_HEADER\]: '1'/)
 assert.match(source,/submit\('PUT'\)/);assert.match(source,/submit\('POST'\)/)
})
