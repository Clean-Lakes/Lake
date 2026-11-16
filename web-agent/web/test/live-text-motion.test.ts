import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement,isValidElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import Markdown from 'react-markdown';
import {AssistantMarkdown,ObjectReferencesProvider} from '../src/AssistantMarkdown';
import {LIVE_TEXT_MOTION_LIMIT,LiveTextMotionLabel,LiveTextMotionText,liveTextMotionParts,remarkLiveTextMotion} from '../src/liveTextMotion';
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

test('a plain animal status label uses one inline text copy with no frame, Markdown or extra announcement',()=>{
 const source='正在搓爪琢磨中';
 const label=(active?:boolean)=>renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:source,active,className:'test-status'}));
 const active=label(true),still=label(false);
 assert.match(active,/^<span class="live-text-motion-label test-status" data-live-motion="active">/);
 assert.equal(active.replace('data-live-motion="active"','data-live-motion="still"'),still);
 assert.equal(label(),still,'labels only move when the caller explicitly marks actual work active');
 assert.equal(plain(active),source);assert.equal(moving(active).join(''),source);
 assert.doesNotMatch(active,/<p\b|<div\b|aria-hidden|aria-label|role=|status-text|animal-thinking/);
 const literal='**原文** <字符> `命令`';
 assert.equal(plain(renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:literal,active:true}))),literal,'the label does not parse or rewrite Markdown');
});

test('plain labels share the bounded grapheme tail and retain empty or whitespace-only text',()=>{
 const source='保持原有前缀'.repeat(40)+'A\u0301 👩🏽‍💻 🇨🇳 继续核对';
 const html=renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:source,active:true}));
 assert.equal(moving(html).length,LIVE_TEXT_MOTION_LIMIT);assert.equal(plain(html),source);
 for(const grapheme of ['A\u0301','👩🏽‍💻','🇨🇳'])assert.ok(moving(html).includes(grapheme));
 for(const text of ['', ' \t\n ']){
  const empty=renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:text,active:true}));
  assert.equal(moving(empty).length,0);assert.equal(plain(empty),text);
 }
});

test('text glow is explicit, follows activity, and preserves the same readable glyph markup',()=>{
 const source='正在搓爪琢磨中';
 const label=(active:boolean,glow?:boolean,className?:string)=>renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:source,active,glow,className}));
 assert.doesNotMatch(label(true),/data-live-glow/,'existing motion-only labels keep their appearance');
 const active=label(true,true),still=label(false,true);
 assert.match(active,/data-live-motion="active" data-live-glow="active"/);
 assert.match(still,/data-live-motion="still" data-live-glow="still"/);
 assert.equal(active.replaceAll('="active"','="still"'),still);
 assert.equal(plain(active),source);assert.equal(moving(active).join(''),source);
 assert.doesNotMatch(active,/aria-hidden|aria-label|role=|status-text|background/,'glow retains opaque actual text without a second sweep or accessible copy');
 const author=label(true,true,'reply-author-name-motion');
 assert.match(author,/class="live-text-motion-label reply-author-name-motion"/);
 assert.equal(plain(author),source);
});

test('ellipsized names can animate only their visible leading graphemes and retain one static suffix',()=>{
 const source='👩🏽‍💻e\u0301负责跨区域生产平台和业务服务可用性核验的长期专员'.repeat(8);
 const graphemes=Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(source));
 const expected=graphemes.slice(0,LIVE_TEXT_MOTION_LIMIT).map(part=>part.segment).join('');
 const active=renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:source,active:true,glow:true,leading:true}));
 const still=renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:source,active:false,glow:true,leading:true}));
 assert.equal(moving(active).length,LIVE_TEXT_MOTION_LIMIT);
 assert.equal(moving(active).join(''),expected,'the animated glyphs remain in the visible name prefix');
 assert.ok(active.includes(source.slice(expected.length)),'the long suffix stays a single static text run');
 assert.equal(plain(active),source);assert.equal(active.replaceAll('="active"','="still"'),still);
 assert.ok(moving(active).includes('👩🏽‍💻'));assert.ok(moving(active).includes('e\u0301'));
 const empty=renderToStaticMarkup(createElement(LiveTextMotionLabel,{children:' \t ',active:true,leading:true}));
 assert.equal(moving(empty).length,0);assert.equal(plain(empty),' \t ');
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
