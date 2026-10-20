type Node = {
 type:string;value?:string;url?:string;ordered?:boolean;children?:Node[];
 data?:{hName?:string;hProperties?:Record<string,unknown>};
};
const labels='提交|分支|检查|验证|测试|耗时|文件|版本|目标|结果';
function fact(paragraph:Node):{label:string;body:Node[]}|null{
 if(paragraph.type!=='paragraph'||!paragraph.children?.length)return null;
 const [first,...rest]=paragraph.children;
 if(first.type==='text'){
  const match=first.value?.match(new RegExp(`^(${labels})[：:][ \\t]*`));
  if(match)return {label:match[1]!,body:[{...first,value:first.value!.slice(match[0].length)},...rest]};
 }
 if(first.type==='strong'&&first.children?.every(child=>child.type==='text')){
  const label=first.children.map(child=>child.value??'').join('').replace(/[：:]$/,'');
  if(!new RegExp(`^(?:${labels})$`).test(label))return null;
  const next=rest[0];
  if(next?.type==='text')return {label,body:[{...next,value:(next.value??'').replace(/^[：:]?[ \t]*/,'')},...rest.slice(1)]};
  return {label,body:rest};
 }
 return null;
}
function facts(paragraph:Node):Array<{label:string;body:Node[]}>|null{
 if(paragraph.type!=='paragraph')return null;
 const lines:Node[][]=[[]];
 for(const child of paragraph.children??[]){
  if(child.type==='break'){lines.push([]);continue;}
  if(child.type!=='text'){lines[lines.length-1]!.push(child);continue;}
  const pieces=(child.value??'').split(/\r?\n/);
  pieces.forEach((value,index)=>{if(index)lines.push([]);if(value)lines[lines.length-1]!.push({...child,value});});
 }
 if(lines.length>1){
  const parsed=lines.map(children=>fact({type:'paragraph',children}));
  if(parsed.every(Boolean))return parsed as Array<{label:string;body:Node[]}>;
 }
 const single=fact(paragraph);return single?[single]:null;
}
function element(type:string,hName:string,children:Node[],className?:string):Node{
 return {type,data:{hName,hProperties:className?{className}:{}},children};
}
function row(info:{label:string;body:Node[]}):Node{
 const body=info.body.map(child=>info.label==='提交'&&child.type==='inlineCode'&&/^[a-f\d]{7,40}$/i.test(child.value??'')
  ?element('replyCommit','span',[child],'reply-commit-token'):child);
 return element('replyFact','div',[element('replyLabel','dt',[{type:'text',value:info.label}]),element('replyValue','dd',body)]);
}

/** Presentation only: use explicitly labeled facts and existing destinations.
 * Do not extract claims from free prose, rewrite stored messages or guess URLs. */
export function remarkReplyInfo(){
 return (tree:Node)=>{
  function visit(parent:Node){
   if(!parent.children||['code','inlineCode','link','linkReference','html','image','imageReference'].includes(parent.type))return;
   if(parent.type==='list'&&!parent.ordered){
    const items=parent.children.map(item=>item.type==='listItem'&&item.children?.length===1?facts(item.children[0]!):null);
    if(items.length&&items.every(Boolean)){
     parent.type='replyFacts';parent.data={hName:'dl',hProperties:{className:'reply-info-facts'}};
     parent.children=items.flatMap(item=>item!.map(row));
     return;
    }
   }
   for(const child of parent.children)visit(child);
   if(parent.type==='listItem')return;
   const output:Node[]=[];
   for(let i=0;i<parent.children.length;i++){
    const info=facts(parent.children[i]!);
    if(info){
     const rows=info.map(row);
     while(i+1<parent.children.length){const next=facts(parent.children[i+1]!);if(!next)break;rows.push(...next.map(row));i++;}
     output.push(element('replyFacts','dl',rows,'reply-info-facts'));
    }else output.push(parent.children[i]!);
   }
   parent.children=output;
   if(parent.type==='paragraph'){
    const content=parent.children.filter(child=>child.type!=='text'||child.value?.trim());
    if(content.length===1&&content[0]?.type==='link'&&resourceLink(content[0].url??'')){
     parent.data={...parent.data,hProperties:{...parent.data?.hProperties,className:'reply-resource'}};
     const link=content[0];link.data={...link.data,hProperties:{...link.data?.hProperties,className:'reply-resource-link'}};
    }
   }
  }
  visit(tree);
 };
}

export function resourceLink(href:string):{source:string}|null{
 try{
  const url=new URL(href);
  if(!['http:','https:'].includes(url.protocol)||!/(?:^|\/)\S+\.[a-z\d]{1,12}$/i.test(url.pathname))return null;
  const parts=url.pathname.split('/').filter(Boolean);
  const owner=url.hostname==='github.com'&&parts.length>=2?' · '+parts.slice(0,2).join('/'):'';
  return {source:url.hostname+owner};
 }catch{return null;}
}

export function quantityParts(text:string):Array<{value:string;unit?:string}>{
 const parts:Array<{value:string;unit?:string}>=[];
 const pattern=/(\d+(?:\.\d+)?)([ \t]*(?:个文件|个节点|项测试|毫秒|分钟|小时|秒|天|GiB|MiB|KiB|GB|MB|KB|ms|s|%|％))(?![\w.])/g;
 let end=0;
 for(const match of text.matchAll(pattern)){
  const at=match.index!;
  if(/[\w./:@+-]/.test(text[at-1]??''))continue;
  if(at>end)parts.push({value:text.slice(end,at)});
  parts.push({value:match[1]!,unit:match[2]!});end=at+match[0].length;
 }
 if(end<text.length)parts.push({value:text.slice(end)});
 return parts.length?parts:[{value:text}];
}
