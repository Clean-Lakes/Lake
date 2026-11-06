import {DatabaseSync,backup} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {chmod,link,lstat,mkdtemp,open,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {HttpError} from './store';

// The old filename is an input-compatibility identifier, never a new output.
export const legacySessionArchiveName = 'zcode-sessions.sqlite';
export const sessionArchiveName = 'agent-sessions.sqlite';
const markerName = '.agent-sessions-origin.json';
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
async function regular(path:string){
 try {
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||process.platform!=='win32'&&stat.uid!==process.getuid?.())throw new HttpError(409,'会话档案必须是当前用户的普通文件');
  return true;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
const serialize=(value:unknown)=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?{integer:item.toString()}:item instanceof Uint8Array?{blob:Buffer.from(item).toString('base64')}:item);
/** Logical content ignores WAL checkpoint/layout changes but detects writes by
 * a previous executable after rollback. No transcript content leaves this host. */
function fingerprint(db:DatabaseSync){
 const schema=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all();
 const tables=schema.filter(row=>row.type==='table').map(row=>String(row.name));
 const contents=tables.map(name=>{
  const statement=db.prepare('SELECT * FROM "'+name.replaceAll('"','""')+'"');statement.setReadBigInts(true);
  const rows:string[]=[];for(const row of statement.iterate())rows.push(hash(serialize(row)));
  return [name,rows.sort()];
 });
 return hash(serialize([schema,contents]));
}

/** Called only after the existing single-Home guard is acquired, before the
 * SDK opens its archive. SQLite backup includes committed WAL data; publication
 * is exclusive and atomic, and the original archive is kept for review. */
export async function prepareSessionArchive(data:string){
 const destination=join(data,sessionArchiveName),legacy=join(data,legacySessionArchiveName),marker=join(data,markerName);
 const hasDestination=await regular(destination),hasLegacy=await regular(legacy);
 if(!hasLegacy){
  if(!hasDestination){const file=await open(destination,'wx',0o600);await file.close();}
  await chmod(destination,0o600);return destination;
 }
 const db=new DatabaseSync(legacy,{readOnly:true});
 try{
  db.exec('BEGIN');const sourceHash=fingerprint(db);
  let origin:{version:number;sourceHash:string}|undefined;
  if(await regular(marker)){
   origin=JSON.parse(await readFile(marker,'utf8'));
   if(origin?.version!==1||origin.sourceHash!==sourceHash)throw new HttpError(409,'旧会话档案发生变化，请先核对两份档案；不会自动覆盖或重放');
  }
  if(hasDestination){
   if(!origin)throw new HttpError(409,'检测到两份会话档案，缺少迁移来源；不会自动选择或合并');
   await chmod(destination,0o600);return destination;
  }
  const staging=await mkdtemp(join(data,'.agent-sessions-import-'));
  try{
   const copy=join(staging,'archive.sqlite');await backup(db,copy);await chmod(copy,0o600);
   const checked=new DatabaseSync(copy,{readOnly:true});
   try{if(fingerprint(checked)!==sourceHash)throw new HttpError(409,'会话档案副本校验失败');}finally{checked.close();}
   const archive=await open(copy,'r+');try{await archive.sync();}finally{await archive.close();}
   if(!origin){
    const stagedMarker=join(staging,'origin.json'),file=await open(stagedMarker,'wx',0o600);
    try{await file.writeFile(JSON.stringify({version:1,sourceHash}));await file.sync();}finally{await file.close();}
    await link(stagedMarker,marker);
   }
   // A crash after the marker but before this link can resume with the same
   // unchanged source. Never replace an independently-created destination.
   await link(copy,destination);
  }finally{await rm(staging,{recursive:true,force:true});}
  return destination;
 }finally{db.close();}
}
