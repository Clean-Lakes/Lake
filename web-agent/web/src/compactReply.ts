type ReplyNode={type:string;value?:string;children?:ReplyNode[];data?:{hName?:string;hProperties?:Record<string,unknown>}};
const text=(node:ReplyNode):string=>node.value??node.children?.map(text).join('')??'';
const hasMedia=(node:ReplyNode):boolean=>['image','imageReference','html'].includes(node.type)||!!node.children?.some(hasMedia);
const boilerplate=/^(结论先行|结论|综合结论|检查结论|结果概览)[：:]?$/;

/** Existing report-shaped replies retain their exact full content behind a
 * disclosure. Only reuse an explicit introductory section, never synthesize
 * an answer from metrics or infer completion from prose. */
export function remarkCompactReply(){
 return (tree:ReplyNode)=>{
  const nodes=tree.children;
  if(!nodes||text(tree).length<700)return;
  const start=nodes[0]?.type==='heading'&&boilerplate.test(text(nodes[0]).trim())?1:0;
  const boundary=nodes.findIndex((node,index)=>index>start&&node.type==='heading');
  if(boundary<0)return;
  const intro=nodes.slice(start,boundary);
  if(!intro.length||intro.length>4||intro.some(node=>node.type!=='paragraph'||hasMedia(node))||intro.some(node=>!text(node).trim())||intro.map(text).join('').length>1200)return;
  // A source heading, table or code-only report cannot supply a trustworthy
  // short answer. It stays fully visible rather than inventing a summary.
  const lead:ReplyNode[]=JSON.parse(JSON.stringify(intro));
  function soften(node:ReplyNode){if(node.data?.hProperties?.className==='assistant-summary')delete node.data.hProperties.className;if(node.children)node.children=node.children.flatMap(child=>{soften(child);return child.type==='strong'&&text(child).length>50?child.children??[]:[child]})}
  lead.forEach(soften);
  tree.children=[...lead,{type:'blockquote',data:{hName:'details',hProperties:{className:'assistant-reply-details'}},children:[{type:'paragraph',data:{hName:'summary'},children:[{type:'text',value:'查看详细结果'}]},...nodes]}];
 };
}
