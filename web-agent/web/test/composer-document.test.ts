import test from 'node:test';
import assert from 'node:assert/strict';
import {composerCaretCharacter,readComposerDocument,setComposerSelection} from '../src/composerDocument';
import {composerToken,type ComposerReference} from '../src/composerMentionState';

// Minimal DOM nodes for document/selection mapping; painting is checked in the real App fixture.
function documentFixture() {
 let selection:{start?:[Node,number];end?:[Node,number]}={};
 const owner={createRange:()=>({setStart:(node:Node,offset:number)=>{selection.start=[node,offset];},setEnd:(node:Node,offset:number)=>{selection.end=[node,offset];}}),getSelection:()=>({removeAllRanges:()=>{},addRange:()=>{}})};
 function node(tag:string,children:Node[]=[],attrs:Record<string,string>={}):HTMLElement {
  const el={nodeType:1,tagName:tag.toUpperCase(),ownerDocument:owner,childNodes:children,parentElement:null,parentNode:null,nextSibling:null,firstChild:children[0]??null,get textContent(){return children.map(child=>child.textContent).join('');},hasAttribute:(name:string)=>name in attrs,getAttribute:(name:string)=>attrs[name]??null} as unknown as HTMLElement;
  children.forEach((child,index)=>Object.assign(child,{parentElement:el,parentNode:el,nextSibling:children[index+1]??null}));return el;
 }
 const text=(value:string)=>({nodeType:3,textContent:value,ownerDocument:owner,parentElement:null,parentNode:null,nextSibling:null}) as unknown as Text;
 return {node,text,selection:()=>selection};
}
const refs:ComposerReference[]=[{kind:'resource',resourceId:'host',label:'@主机',position:0}];
test('marked caret boundary stays out of drafts while ordinary zero-width text is preserved',()=>{
 const d=documentFixture(),chip=d.node('span',[],{'data-composer-token':'resource:host'}),anchor=d.node('span',[d.text(composerCaretCharacter)],{'data-composer-caret':''});
 const root=d.node('div',[chip,anchor,d.text(`后${composerCaretCharacter}`)]);
 assert.deepEqual(readComposerDocument(root,refs),{value:`${composerToken}后${composerCaretCharacter}`,references:refs});
});
test('text composed inside a caret boundary is retained in its correct logical position',()=>{
 const d=documentFixture(),chip=d.node('span',[],{'data-composer-token':'resource:host'}),anchor=d.node('span',[d.text(composerCaretCharacter+'状态🔎')],{'data-composer-caret':''});
 assert.equal(readComposerDocument(d.node('div',[chip,anchor]),refs).value,composerToken+'状态🔎');
 const before=d.node('span',[d.text('状'+composerCaretCharacter+'态')],{'data-composer-caret':''});
 assert.equal(readComposerDocument(d.node('div',[chip,before]),refs).value,composerToken+'状态');
});
test('restored caret after a trailing reference uses editable text rather than an unpainted element boundary',()=>{
 const d=documentFixture(),chip=d.node('span',[],{'data-composer-token':'resource:host'}),tail=d.text(composerCaretCharacter),root=d.node('div',[chip,d.node('span',[tail],{'data-composer-caret':''})]);
 setComposerSelection(root,1);
 assert.deepEqual(d.selection(),{start:[tail,1],end:[tail,1]});
});
test('selection at a reference followed by prose targets the prose and keeps UTF-16 offsets',()=>{
 const d=documentFixture(),chip=d.node('span',[],{'data-composer-token':'resource:host'}),tail=d.text('🔎后续'),root=d.node('div',[chip,tail]);
 setComposerSelection(root,1,3);
 assert.deepEqual(d.selection(),{start:[tail,0],end:[tail,2]});
});
