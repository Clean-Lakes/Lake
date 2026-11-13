import { createServer, request, type Server } from 'node:http';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

export type BridgeTool = { name: string; description: string; inputSchema: Record<string, unknown> };
/** One private, task-bound socket. There is no settings, credentials, or store API. */
export async function openToolBridge(tools: BridgeTool[], invoke: (name: string, input: unknown, callId: string) => Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(),'lake-acp-'));
  await chmod(directory, 0o700);
  const socket = join(directory,'tools.sock');
  let open = true;
  const server = createServer(async (req,res) => {
    res.setHeader('Content-Type','application/json');
    try {
      if (!open) throw new Error('原任务已停止');
      if (req.method === 'GET' && req.url === '/tools') { res.end(JSON.stringify(tools)); return; }
      if (req.method !== 'POST' || req.url !== '/call') { res.writeHead(404); res.end('{}'); return; }
      const chunks: Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw new Error('工具请求过大');chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(typeof input.name!=='string'||!tools.some(tool=>tool.name===input.name))throw new Error('当前任务未提供该工具');
      const output=await invoke(input.name,input.input,'mcp:'+randomUUID());
      if(!open)throw new Error('原任务已停止');
      res.end(JSON.stringify({output}));
    }catch(error){res.writeHead(409);res.end(JSON.stringify({error:error instanceof Error?error.message.slice(0,4096):'Lake 工具调用未成功'}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socket,()=>resolve());});
  await chmod(socket,0o600);
  return {socket,async close(){open=false;server.closeAllConnections();await closeServer(server);await rm(directory,{recursive:true,force:true});}};
}
function closeServer(server:Server){return new Promise<void>(resolve=>server.close(()=>resolve()));}
async function bridgeRequest(socket:string,path:string,input?:unknown){
  return new Promise<any>((resolve,reject)=>{
    const req=request({socketPath:socket,path,method:input===undefined?'GET':'POST',headers:{'Content-Type':'application/json'}},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024){req.destroy(new Error('工具结果过大'));return;}chunks.push(chunk);});
      res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode!==200)reject(new Error(result.error));else resolve(result);}catch(error){reject(error);}});
    });
    req.setTimeout(600000,()=>req.destroy(new Error('工具桥等待超时')));req.on('error',reject);req.end(input===undefined?undefined:JSON.stringify(input));
  });
}
/** A standard MCP server for the Codex adapter. Its only authority is its parent run's socket. */
export async function runToolBridge(socket:string){
  const tools:BridgeTool[]=await bridgeRequest(socket,'/tools');
  const server=new McpServer({name:'lake-task-tools',version:'1.0.0'});
  for(const tool of tools)server.registerTool(tool.name,{description:tool.description,inputSchema:z.fromJSONSchema(tool.inputSchema as any)},async input=>{
    const result=await bridgeRequest(socket,'/call',{name:tool.name,input});
    return {content:[{type:'text' as const,text:JSON.stringify(result.output)}]};
  });
  await server.connect(new StdioServerTransport());
}
