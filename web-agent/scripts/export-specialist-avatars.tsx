import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentIcon} from '../web/src/AgentIcon';
import {avatarPaintStyle,lakeAvatarArtwork} from '../web/src/lakeAvatarArtwork';
import {lakeAvatarMotions} from '../web/src/lakeAvatarMotion';
import {lakeAvatarCatalog,lakeAvatarGroups} from '../web/src/lakeAvatarCatalog';

const root=fileURLToPath(new URL('../../',import.meta.url));
const output=resolve(process.argv[2]||join(root,'dist/specialist-avatars-100'));
const palettes=['river','moss','reed','clay'];
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const motionCSS=await readFile(join(root,'web-agent/web/src/specialistAvatars.css'),'utf8');
await mkdir(join(output,'svg'),{recursive:true});
const manifest=[];
const tiles=[];
for(const [index,avatar] of lakeAvatarCatalog.entries()){
 const number=String(index+1).padStart(3,'0'),filename=`${number}-${avatar.id}.svg`;
 const art=renderToStaticMarkup(createElement(AgentIcon,{role:avatar.id,size:22}));
 let svg=art.replace(/ style="[^"]*"/,'').replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" ')
  .replace('width="22" height="22"','width="64" height="64"')
  .replace('aria-hidden="true"',`role="img" aria-label="${escape(avatar.name)}"`);
 for(const [name,value] of Object.entries(avatarPaintStyle(lakeAvatarArtwork[avatar.id].palette))){
  const colour=value.match(/^light-dark\(([^,]+),/)![1];svg=svg.replaceAll(`var(${name})`,colour);
 }
 if(svg.includes('var('))throw new Error(`Unresolved paint in ${avatar.id}`);
 await writeFile(join(output,'svg',filename),svg+'\n');
 manifest.push({number:index+1,id:avatar.id,name:avatar.name,family:avatar.family,file:`svg/${filename}`});
 tiles.push(`<a class="avatar-tile" href="svg/${filename}" download aria-label="下载 ${escape(avatar.name)} SVG" data-family="${avatar.family}"><span class="super-role-avatar" data-role="${avatar.id}" data-palette="${palettes[index%4]}" data-motion="idle" style="--avatar-phase:${-(index*137%7600)}ms;--avatar-greet-time:${lakeAvatarMotions[avatar.id].greetMs}ms">${art}</span><strong>${number} ${escape(avatar.name)}</strong></a>`);
}
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(join(output,'README.txt'),'Lake 专员头像库 · 100 个不同几何的 SVG\n\n打开 index.html 查看总览；点击头像可下载对应 SVG。svg/ 中恰含 100 个独立矢量文件，manifest.json 保存编号、名称和文件映射。\n\n背景透明；自然分色、深色眼睛与少量纹理；静态 SVG 已解析成可编辑的明色颜色值，不依赖 CSS 变量。运行时的主题、动画及 RoleID 分配由 Lake 共享组件提供，独立 SVG 为静态导出。\n\n本目录由 web-agent/scripts/export-specialist-avatars.tsx 从产品同一绘图源生成，不在此手工修改。\n');
const filters=lakeAvatarGroups.map(group=>`<button type="button" data-filter="${group.family}">${group.label}</button>`).join('');
const html=`<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lake · 100 个专员头像</title><style>
:root{color-scheme:light;--background:#fafafa;--foreground:#202322;--text-muted:#6e7672;--border:#e0e5e1;--surface-hover:#edf0ed;--agent-coordinator:#52758b;--agent-investigator:#557f78;--agent-executor:#9b7957;--agent-verifier:#70856b;--corner-window:superellipse(1.5)}
:root[data-theme=dark]{color-scheme:dark;--background:#141615;--foreground:#e4e8e5;--text-muted:#a1aaa4;--border:#343b36;--surface-hover:#252b27;--agent-coordinator:#9db9cb;--agent-investigator:#9bc2b8;--agent-executor:#cdb18d;--agent-verifier:#afc3a7}
*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground);font:14px/1.5 system-ui,-apple-system,sans-serif}main{max-width:1360px;margin:auto;padding:32px}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h1{margin:0;font-size:27px;font-weight:600}p{color:var(--text-muted);margin:8px 0}button{font:inherit;color:inherit;border:1px solid var(--border);border-radius:10px;corner-shape:var(--corner-window);background:transparent;padding:8px 12px;cursor:pointer}button:hover,button[aria-pressed=true]{background:var(--surface-hover)}button:focus-visible,.avatar-tile:focus-visible{outline:2px solid var(--agent-coordinator);outline-offset:3px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:22px 0}.filters{margin:0 0 18px}#counter{color:var(--text-muted);margin-left:8px}.grid{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:10px}.avatar-tile{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:11px;min-height:91px;border:1px solid var(--border);border-radius:14px;corner-shape:var(--corner-window);text-decoration:none;color:inherit;padding:14px 4px 12px}.avatar-tile:hover{background:var(--surface-hover)}.avatar-tile[hidden]{display:none}.avatar-tile strong{font-size:12px;font-weight:400;white-space:nowrap}.super-role-avatar{display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px}.super-role-avatar>svg{width:64px;height:64px}body[data-size=small] .super-role-avatar{width:22px;height:22px}body[data-size=small] .super-role-avatar>svg{width:22px;height:22px}@media(max-width:1000px){.grid{grid-template-columns:repeat(8,minmax(0,1fr))}}@media(max-width:700px){main{padding:18px}.grid{grid-template-columns:repeat(5,minmax(0,1fr));gap:7px}h1{font-size:22px}.avatar-tile strong{font-size:11px}.toolbar button{padding:7px 9px}}@media(max-width:420px){.grid{grid-template-columns:repeat(4,minmax(0,1fr))}}${motionCSS}
</style></head><body><main><header><div><h1>Lake · 100 个专员头像</h1><p>100 个不同图形 · 本地 SVG · 点击下载单个头像</p></div><button id="theme" type="button">切换深色</button></header><div class="toolbar" role="group" aria-label="动画预览"><button type="button" data-motion-control="idle" aria-pressed="true">闲时</button><button type="button" data-motion-control="working" aria-pressed="false">工作中</button><button type="button" data-motion-control="still" aria-pressed="false">静止</button><button id="greet" type="button">播放回应动作</button><button id="size" type="button" aria-pressed="false">查看 22px</button><span id="counter">显示 100 / 100</span></div><div class="toolbar filters" role="group" aria-label="生态分类"><button type="button" data-filter="all" aria-pressed="true">全部</button>${filters}</div><div class="grid">${tiles.join('')}</div><p>角色权限与任务状态独立于头像；预览不会执行任务。独立 SVG 文件为静态矢量，页面支持轻动效预览。</p></main><script>
document.querySelector('#theme').onclick=function(){const dark=document.documentElement.dataset.theme!=='dark';document.documentElement.dataset.theme=dark?'dark':'light';this.textContent=dark?'切换浅色':'切换深色'};
document.querySelector('#greet').onclick=()=>{if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;document.querySelectorAll('.super-role-avatar').forEach(a=>{a.classList.remove('is-greeting');void a.offsetWidth;a.classList.add('is-greeting')})};
document.addEventListener('animationend',event=>{if(event.animationName==='lake-avatar-greet-done')event.target.classList.remove('is-greeting')});
document.querySelector('#size').onclick=function(){const small=document.body.dataset.size!=='small';document.body.dataset.size=small?'small':'';this.setAttribute('aria-pressed',String(small));this.textContent=small?'查看 64px':'查看 22px'};
document.querySelectorAll('[data-motion-control]').forEach(button=>button.onclick=function(){document.querySelectorAll('[data-motion-control]').forEach(b=>b.setAttribute('aria-pressed',String(b===this)));document.querySelectorAll('.super-role-avatar').forEach(a=>a.dataset.motion=this.dataset.motionControl)});
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=function(){document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===this)));let count=0;document.querySelectorAll('.avatar-tile').forEach(tile=>{tile.hidden=this.dataset.filter!=='all'&&tile.dataset.family!==this.dataset.filter;if(!tile.hidden)count++});document.querySelector('#counter').textContent='显示 '+count+' / 100'});
document.addEventListener('visibilitychange',()=>document.querySelectorAll('.super-role-avatar').forEach(a=>{if(document.hidden)a.setAttribute('data-hidden','true');else a.removeAttribute('data-hidden')}));
</script></body></html>`;
await writeFile(join(output,'index.html'),html);
console.log(JSON.stringify({output,count:manifest.length}));
