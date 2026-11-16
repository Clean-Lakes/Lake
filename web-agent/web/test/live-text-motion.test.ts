import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement,isValidElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import {AssistantMarkdown,ObjectReferencesProvider} from '../src/AssistantMarkdown';
import {LIVE_TEXT_MOTION_LIMIT,LiveTextMotionText,liveTextMotionParts,remarkLiveTextMotion} from '../src/liveTextMotion';
import {objectCatalog,remarkObjectReferences} from '../src/objectReferences';
import type {Resource} from '../../shared/contracts';

const render=(children:string,liveMotion?:boolean)=>renderToStaticMarkup(createElement(AssistantMarkdown,{children,liveMotion}));
const plain=(html:string)=>html.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#x27;/g,"'");
const moving=(html:string)=>Array.from(html.matchAll(/class="live-text-motion-character"[^>]*>([^<]*)<\/span>/g),match=>match[1]!);

test('ordinary Markdown stays unchanged; opt-in motion uses one copy and stops without changing its markup',()=>{
 const source='正在核对中文与 English words 👩🏽‍💻 e\u0301。';
 const ordinary=render(source),active=render(source,true),still=render(source,false);
 assert.doesNotMatch(ordinary,/live-text-motion|data-live-motion/);
 assert.match(active,/data-live-motion="active"/);assert.match(still,/data-live-motion="still"/);
 assert.equal(active.replace('data-live-motion="active"','data-live-motion="still"'),still);
 assert.equal(plain(active),plain(ordinary));
 assert.doesNotMatch(active,/aria-hidden|aria-label|role="status"/,'the actual text remains the only accessible/readable copy');
 assert.doesNotMatch(active,/<lake-live-text/,'the private Markdown node renders as a normal inline span');
});

test('retiring an earlier motion host cannot change an existing object reference React key',()=>{
 const host:Resource={id:'host',projectId:'project',kind:'ssh',name:'验收服务器',description:'',status:'available',ssh:{host:'192.0.2.2',port:22,username:'operator'}};
 const decorate=remarkObjectReferences(objectCatalog([host]));
 const references=(children:ReactNode):Array<{key:string|null;type:unknown;id:string}>=>{
  if(Array.isArray(children))return children.flatMap(references);
  if(!isValidElement<{children?:ReactNode;'data-object-key'?:string}>(children))return [];
  const id=children.props['data-object-key'];
  return id?[{key:children.key,type:children.type,id}]:references(children.props.children);
 };
 const tree=(children:string)=>Markdown({children,remarkPlugins:[decorate,remarkLiveTextMotion]});
 const before='之前 验收服务器 后';
 const original=references(tree(before));
 assert.deepEqual(original,[{key:'span-0',type:'span',id:'resource:host'}]);
 for(const suffix of ['继续核对','新收到的真实文字'.repeat(8)]){
  assert.deepEqual(references(tree(before+suffix)),original,'the reference keeps the same sibling key while prose enters or leaves the motion tail');
 }
});

test('the last 24 readable graphemes share one budget across paragraphs, emphasis, and lists',()=>{
 const source='早期静止正文'.repeat(120)+'\n\n- **刚刚更新**：甲乙丙丁戊己庚辛壬癸\n- 当前结果保持真实并且继续核对最新数据';
 const html=render(source,true);
 assert.equal(moving(html).length,LIVE_TEXT_MOTION_LIMIT);
 assert.equal(plain(html),plain(render(source)));
 assert.ok(html.includes('早期静止正文'.repeat(120)),'a long earlier prefix does not create animated nodes');
 assert.match(html,/<strong>/);assert.match(html,/<ul>/);assert.match(html,/<li>/);
});

test('grapheme spans preserve emoji, combining marks, Chinese, English whitespace and newlines',()=>{
 const text='中 A\u0301 👩🏽‍💻 🇨🇳 👨‍👩‍👧‍👦\nEnglish words\t末尾';
 const parts=liveTextMotionParts(text,0);
 assert.equal(parts.map(part=>part.text).join(''),text);
 for(const grapheme of ['A\u0301','👩🏽‍💻','🇨🇳','👨‍👩‍👧‍👦'])assert.ok(parts.some(part=>part.text===grapheme));
 assert.ok(parts.filter(part=>/^\s+$/u.test(part.text)).every(part=>!part.moving));
 assert.equal(plain(renderToStaticMarkup(createElement(LiveTextMotionText,{text,start:0}))),text);
 assert.equal(liveTextMotionParts('字'+' '.repeat(5000)+'末',0).length,3,'whitespace is retained without creating thousands of fragments');
});

test('overlapping streamed graphemes keep stable offset keys and phases as the tail advances',()=>{
 const before='abcdefghijklmnopqrstuvwxyz',after=before+'新';
 const pieces=(text:string,start:number)=>LiveTextMotionText({text,start}).props.children[1] as {key:string;props:{children:{props:{style:unknown;children:string}}}}[];
 const old=pieces(before,2),next=pieces(after,3);
 const byKey=new Map(next.map(piece=>[piece.key,piece]));
 for(const piece of old.slice(1)){
  const kept=byKey.get(piece.key);assert.ok(kept);
  assert.deepEqual(kept.props.children.props,piece.props.children.props);
 }
});

test('links, code, tables, quotes and existing reference controls retain their markup and content',()=>{
 const source='[打开原链接](https://example.test/report) `printf hello`\n\n```sh\necho done\n```\n\n> 引用内容不重复。\n\n| 列名 | 值 |\n| --- | --- |\n| 项目 | 固定单元格 |\n\n普通尾部';
 const ordinary=render(source),active=render(source,true);
 for(const pattern of [/<a\b[^>]*>[\s\S]*?<\/a>/,/<code>[\s\S]*?<\/code>/,/<pre\b[^>]*>[\s\S]*?<\/pre>/,/<table\b[^>]*>[\s\S]*?<\/table>/])assert.equal(active.match(pattern)?.[0],ordinary.match(pattern)?.[0]);
 assert.match(active,/<blockquote>/);assert.equal(plain(active),plain(ordinary));
 const host:Resource={id:'host',projectId:'project',kind:'ssh',name:'验收服务器',description:'',status:'available',ssh:{host:'192.0.2.2',port:22,username:'operator'}};
 const reference=(liveMotion?:boolean)=>renderToStaticMarkup(createElement(ObjectReferencesProvider,{resources:[host],children:createElement(AssistantMarkdown,{children:'核对验收服务器后继续。',liveMotion})}));
 const button=/<button\b[^>]*>[\s\S]*?<\/button>/;
 assert.equal(reference(true).match(button)?.[0],reference().match(button)?.[0]);
 assert.match(reference(true),/data-object-id="resource:host"/);
});
