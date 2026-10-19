import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FileChanges} from '../src/FileChanges';
import {FilePreview} from '../src/FilePreview';
import {fileName,linkedFile} from '../src/fileLinks';
import {summarizeFileChanges} from '../src/file-changes-model';
import type {AICard} from '../../shared/contracts';
const diff=(id:string,path:string,extra:Record<string,unknown>={}):AICard=>({id,type:'diff',title:path,status:'completed',at:'',data:{runtime:'ssh',assetRef:'host-a',before:'',after:'# 已保存的方案',existed:false,...extra}});
const files=(...cards:AICard[])=>summarizeFileChanges(cards).files;

test('successful recorded outputs have direct file links before the collapsed diff, failures never invent links',()=>{
 const html=renderToStaticMarkup(createElement(FileChanges,{resources:[],cards:[diff('1','/plans/PLAN.md'),diff('2','/plans/deploy.yaml'),{...diff('3','/plans/failed.sh'),status:'failed'}]}));
 assert.ok(html.includes('aria-label="本轮文件"'));
 assert.ok(html.indexOf('PLAN.md')<html.indexOf('file-changes-badge'));
 assert.ok(html.includes('deploy.yaml')&&!html.includes('failed.sh'));
 const ids=[...html.matchAll(/id="(lake-file-[^"]+)"/g)].map(m=>m[1]);
 const links=[...html.matchAll(/href="#([^"]+)"/g)].map(m=>decodeURIComponent(m[1]!));
 assert.equal(ids.length,2);assert.ok(links.every(link=>ids.includes(link)));
});
test('relative document links remain on their actual resource and directory; ambiguous handles are not guessed',()=>{
 const recorded=files(diff('1','/plans/PLAN.md'),diff('2','/plans/scripts/restore.sh'),diff('3','/other/scripts/restore.sh'),diff('4','/plans/scripts/restore.sh',{assetRef:'host-b'}));
 assert.equal(linkedFile(recorded,'scripts/restore.sh',recorded[0])?.id,recorded[1]?.id);
 assert.equal(linkedFile(recorded,'restore.sh'),undefined);
 assert.equal(linkedFile(recorded,'scripts/restore.sh'),undefined);
 for(const href of ['../scripts/restore.sh','file:///etc/passwd','javascript:alert(1)','//example.test/x','/etc/passwd','scripts/restore.sh?run=1','scripts/restore.sh#L1','%ZZ'])assert.equal(linkedFile(recorded,href,recorded[0]),undefined);
 assert.equal(fileName('C:\\work\\Plan.md'),'Plan.md');
 const containers=files(diff('5','/PLAN.md',{runtime:'container',containerId:'one'}),diff('6','/restore.sh',{runtime:'container',containerId:'two'}));
 assert.equal(linkedFile(containers,'restore.sh',containers[0]),undefined);
});
test('preview renders saved Markdown and related file links without loading remote images or executing HTML',()=>{
 const recorded=files(diff('1','/plans/PLAN.md',{after:'# 迁移方案\n\n[恢复脚本](scripts/restore.sh)\n\n![跟踪图片](https://example.test/track.png)\n\n<script>alert(1)</script>'}),diff('2','/plans/scripts/restore.sh'));
 const html=renderToStaticMarkup(createElement(FilePreview,{file:recorded[0]!,files:recorded,target:'演示主机',hrefFor:()=> '#known-file',onOpen:()=>{},onClose:()=>{}}));
 assert.ok(html.includes('<h1>迁移方案</h1>')&&html.includes('href="#known-file"'));
 assert.ok(html.includes('会话中保存的版本'));
 assert.ok(!html.includes('<img')&&!html.includes('<script>'));
 const deleted=files(diff('3','/plans/old.sh',{before:'old recorded content',after:'',existed:true,deleted:true}));
 const old=renderToStaticMarkup(createElement(FilePreview,{file:deleted[0]!,files:deleted,target:'演示主机',hrefFor:()=> '#old',onOpen:()=>{},onClose:()=>{}}));
 assert.ok(old.includes('已删除，显示变更前内容')&&old.includes('old recorded content'));
});
