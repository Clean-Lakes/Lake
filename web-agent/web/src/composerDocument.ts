import {composerToken,type ComposerReference} from './composerMentionState';
export const referenceKey=(ref:ComposerReference)=>`${ref.kind}:${ref.resourceId}`;
export function readComposerDocument(root:Node,references:ComposerReference[]) {
 const lookup=new Map(references.map(ref=>[referenceKey(ref),ref]));
 let value='';const refs:ComposerReference[]=[];
 function walk(node:Node) {
  if(node.nodeType===3){value+=(node.textContent??'').replace(/\u00a0/g,' ');return;}
  if(node.nodeType===1){
   const el=node as HTMLElement;
   if(el.hasAttribute('data-composer-suggestion'))return;
   const key=el.getAttribute('data-composer-token');
   if(key){const ref=lookup.get(key);if(ref)refs.push({...ref,position:value.length});value+=composerToken;return;}
   if(el.tagName==='BR'){if(el.hasAttribute('data-composer-break'))value+='\n';return;}
   if(['DIV','P'].includes(el.tagName)&&node!==root&&value&&!value.endsWith('\n'))value+='\n';
  }
  for(const child of node.childNodes)walk(child);
 }
 walk(root);
 return {value,references:refs};
}
export function composerRangeOffsets(root:HTMLElement,references:ComposerReference[],range:Pick<Range,'startContainer'|'startOffset'|'endContainer'|'endOffset'>) {
 if(!root.contains(range.startContainer)||!root.contains(range.endContainer))return null;
 const count=(container:Node,offset:number)=>{const prefix=root.ownerDocument.createRange();prefix.setStart(root,0);prefix.setEnd(container,offset);return readComposerDocument(prefix.cloneContents(),references).value.length;};
 return {start:count(range.startContainer,range.startOffset),end:count(range.endContainer,range.endOffset)};
}
export function composerSelection(root:HTMLElement,references:ComposerReference[]) {
 const selection=root.ownerDocument.getSelection();
 return selection?.rangeCount?composerRangeOffsets(root,references,selection.getRangeAt(0)):null;
}
export function setComposerSelection(root:HTMLElement,start:number,end=start) {
 function point(offset:number):[Node,number] {
  let remaining=Math.max(0,offset);let found:[Node,number]|null=null;
  function walk(node:Node) {
   if(found)return;
   if(node.nodeType===3){const length=node.textContent?.length??0;if(remaining<=length)found=[node,remaining];else remaining-=length;return;}
   const el=node.nodeType===1?node as HTMLElement:null;
   if(el?.hasAttribute('data-composer-suggestion')||el?.tagName==='BR'&&!el.hasAttribute('data-composer-break'))return;
   if(el?.hasAttribute('data-composer-token')||el?.hasAttribute('data-composer-break')){
    const parent=node.parentNode!;const index=Array.prototype.indexOf.call(parent.childNodes,node) as number;
    if(remaining<=1)found=[parent,index+remaining];else remaining--;return;
   }
   for(const child of node.childNodes)walk(child);
  }
  walk(root);return found??[root,root.childNodes.length];
 }
 const [a,ao]=point(start),[b,bo]=point(end),range=root.ownerDocument.createRange();range.setStart(a,ao);range.setEnd(b,bo);
 const selection=root.ownerDocument.getSelection();selection?.removeAllRanges();selection?.addRange(range);
}
