// Real App with fictional data. Diagnostics only observe editor state; never send a message.
import './composer-model-workbench';
import {composerSelection,readComposerDocument} from '../../src/composerDocument';
import {type ComposerReference} from '../../src/composerMentionState';
const proof=document.createElement('output');proof.id='composer-caret-proof';proof.hidden=true;document.body.appendChild(proof);
const refs:ComposerReference[]=[{kind:'resource',resourceId:'order-api',label:'@订单服务 · order-api',position:0},{kind:'resource',resourceId:'postgres',label:'@订单数据库 · PostgreSQL',position:0},{kind:'resource',resourceId:'gateway',label:'@网关 · edge-01',position:0}];
function record(){requestAnimationFrame(()=>{const root=document.querySelector<HTMLElement>('#message-input');if(!root)return;const selection=document.getSelection();const range=selection?.rangeCount?selection.getRangeAt(0):null;const logical=readComposerDocument(root,refs);proof.textContent=JSON.stringify({document:logical,selection:composerSelection(root,refs),focused:document.activeElement===root,anchor:selection?.anchorNode?.nodeName,anchorOffset:selection?.anchorOffset,anchorParent:selection?.anchorNode?.parentElement?.className,range:range?.getBoundingClientRect().toJSON(),nodes:[...root.childNodes].map(node=>({name:node.nodeName,text:node.nodeType===3?node.textContent:undefined,placeholder:(node as HTMLElement).hasAttribute?.('data-composer-placeholder')})),html:root.innerHTML});});}
for(const event of ['selectionchange','input','keyup','focusin','click'])document.addEventListener(event,record);
