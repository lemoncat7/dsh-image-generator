import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, realpath, unlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

/** Workspace-local, bounded operational records; never credentials or automatic long-term memories. */
export async function beginImageDiagnostic(cwd:string,initial:Record<string,unknown>) {
  try {
    const root=await realpath(cwd),parent=join(root,'.image-generation')
    await mkdir(parent,{recursive:true,mode:0o700})
    const parentPath=await realpath(parent),parentWithin=relative(root,parentPath)
    if(parentWithin==='..'||parentWithin.startsWith('..'+sep))return undefined
    const directory=join(parentPath,'attempts')
    await mkdir(directory,{recursive:true,mode:0o700})
    const actual=await realpath(directory),within=relative(root,actual)
    if(within==='..'||within.startsWith('..'+sep))return undefined
    const path=join(actual,`${Date.now()}-${randomUUID()}.json`)
    const file=await open(path,'wx',0o600)
    const base={schemaVersion:1,startedAt:new Date().toISOString(),...initial}
    const write=async(value:Record<string,unknown>)=>{
      const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n')
      await file.write(bytes,0,bytes.length,0);await file.truncate(bytes.length)
    }
    try {await write({...base,status:'running'})}catch{await file.close();return undefined}
    return {path,async finish(result:Record<string,unknown>):Promise<string|undefined>{
      let saved=false
      try{await write({...base,...result,finishedAt:new Date().toISOString()});saved=true}catch{/* Diagnostics must not change the operation result. */}
      finally{await file.close().catch(()=>{})}
      // Remove only completed records with our generated filenames, never active attempts or unrelated files.
      try{
        const names=(await readdir(actual,{withFileTypes:true})).filter(e=>e.isFile()).map(e=>e.name).filter(n=>/^\d+-[a-f0-9-]{36}\.json$/.test(n)).sort().reverse()
        const completed=[] as string[]
        for(const name of names){try{const v=JSON.parse(await readFile(join(actual,name),'utf8'));if(v.schemaVersion===1&&v.finishedAt)completed.push(name)}catch{}}
        for(const name of completed.slice(50))await unlink(join(actual,name)).catch(()=>{})
      }catch{}
      return saved?path:undefined
    }}
  }catch{return undefined}
}
