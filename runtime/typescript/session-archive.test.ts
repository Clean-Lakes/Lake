import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,readdir,rm,symlink,stat,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {legacySessionArchiveName,prepareSessionArchive,sessionArchiveName} from './session-archive';

async function fixture(t:import('node:test').TestContext){
 const directory=await mkdtemp(join(tmpdir(),'lake-session-archive-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;
}
function seed(path:string){const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE archive(id TEXT PRIMARY KEY,body TEXT);');db.prepare('INSERT INTO archive VALUES(?,?)').run('original-session','actual transcript');return db;}
const rows=(path:string)=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT * FROM archive').all();}finally{db.close();}};

test('fresh runtime creates only a private neutral session archive',async t=>{
 const directory=await fixture(t),path=await prepareSessionArchive(directory);
 assert.equal(path,join(directory,sessionArchiveName));assert.deepEqual(await readdir(directory),[sessionArchiveName]);
 if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
});
test('legacy archive copies committed WAL content and preserves the original history',async t=>{
 const directory=await fixture(t),old=join(directory,legacySessionArchiveName),db=seed(old);
 const before=await readFile(old),wal=await readFile(old+'-wal');
 const path=await prepareSessionArchive(directory);
 assert.deepEqual(rows(path),rows(old));assert.deepEqual(await readFile(old),before);assert.deepEqual(await readFile(old+'-wal'),wal);
 db.close(); // A checkpoint changes storage layout, not logical history.
 assert.equal(await prepareSessionArchive(directory),path);
 assert.equal((await readdir(directory)).some(name=>name.startsWith('.agent-sessions-import-')),false);
});
test('completed migration keeps newer native history and detects a legacy writer after rollback',async t=>{
 const directory=await fixture(t),old=join(directory,legacySessionArchiveName);seed(old).close();
 const path=await prepareSessionArchive(directory),current=new DatabaseSync(path);
 current.prepare('INSERT INTO archive VALUES(?,?)').run('new-session','new history');current.close();
 assert.equal(await prepareSessionArchive(directory),path);assert.equal(rows(path).length,2);
 const legacy=new DatabaseSync(old);legacy.prepare('INSERT INTO archive VALUES(?,?)').run('old-executable-session','different history');legacy.close();
 const before=await readFile(path);await assert.rejects(()=>prepareSessionArchive(directory),/旧会话档案发生变化/);assert.deepEqual(await readFile(path),before);
});
test('a crash after the origin marker resumes without duplicating or replaying records',async t=>{
 const directory=await fixture(t),old=join(directory,legacySessionArchiveName);seed(old).close();
 const path=await prepareSessionArchive(directory);await unlink(path);
 assert.equal(await prepareSessionArchive(directory),path);assert.deepEqual(rows(path),rows(old));
});
test('ambiguous independent archives and symlinks fail without overwriting either history',async t=>{
 const directory=await fixture(t),old=join(directory,legacySessionArchiveName);seed(old).close();
 const path=join(directory,sessionArchiveName);seed(path).close();const before=await readFile(path);
 await assert.rejects(()=>prepareSessionArchive(directory),/检测到两份会话档案/);assert.deepEqual(await readFile(path),before);
 await unlink(path);await symlink(old,path);
 await assert.rejects(()=>prepareSessionArchive(directory),/普通文件/);
});
