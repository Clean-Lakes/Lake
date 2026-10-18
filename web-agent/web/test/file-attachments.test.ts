import assert from 'node:assert/strict';
import test from 'node:test';
import {clipboardFiles,partitionAttachments,attachmentLimit,fileSize} from '../src/fileAttachments';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AITranscript} from '../src/AIPanel';
import type {SessionSnapshot} from '../../shared/contracts';
const file=(name:string,type:string,size:number)=>({name,type,size}) as File;
test('clipboard includes archives and arbitrary binaries without duplicating items/files',()=>{
 const zip=file('deploy.zip','application/zip',100),binary=file('app.bin','',64);
 const data={items:[{kind:'file',getAsFile:()=>zip},{kind:'file',getAsFile:()=>binary},{kind:'string',getAsFile:()=>null}],files:[zip,binary]} as unknown as DataTransfer;
 assert.deepEqual(clipboardFiles(data),[zip,binary]);
 assert.deepEqual(clipboardFiles({items:[],files:[binary]} as unknown as DataTransfer),[binary]);
 assert.deepEqual(clipboardFiles({items:[{kind:'string'}],files:[]} as unknown as DataTransfer),[]);
});
test('file selection accepts unknown MIME, empty files and archives while keeping image limits',()=>{
 const zip=file('deploy.tar.gz','application/gzip',20),empty=file('empty','',0),largeImage=file('large.png','image/png',3*1024*1024),preview=file('screen.png','image/png',40);
 assert.deepEqual(partitionAttachments([zip,empty,largeImage,preview],[],true),{files:[zip,empty,largeImage],images:[preview]});
 assert.deepEqual(partitionAttachments([preview],[],false),{files:[preview],images:[]});
 assert.throws(()=>partitionAttachments([file('too-big','',attachmentLimit+1)],[],false),/512 MiB/);
 assert.equal(fileSize(0),'0 B');assert.equal(fileSize(1024),'1.0 KiB');
});
test('sent attachment remains visible with an encoded session-scoped download link',()=>{
 const snapshot={session:{id:'fixture'},messages:[{id:'m',role:'user',text:'deploy',createdAt:'2026-10-18T00:00:00Z',files:[{sourceId:'file-abc',name:'部署包.zip'}]}],actions:[],ai:{session:'fixture',status:'completed',profile:'core',cards:[],cardsOffset:0,turns:1}} as SessionSnapshot;
 const html=renderToStaticMarkup(createElement(AITranscript,{snapshot}));
 assert.ok(html.includes('部署包.zip'));assert.ok(html.includes('/api/sessions/fixture/attachments/file-abc'));assert.ok(html.includes('download='));
});
