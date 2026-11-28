import { createServer, request, type Server } from 'node:http';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
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
function toolServer(tools:BridgeTool[],invoke:(name:string,input:unknown)=>Promise<unknown>){
  const server=new McpServer({name:'lake-task-tools',version:'1.0.0'});
  for(const tool of tools)server.registerTool(tool.name,{description:tool.description,inputSchema:z.fromJSONSchema(tool.inputSchema as any)},async input=>{
    const text=JSON.stringify(await invoke(tool.name,input));
    if(Buffer.byteLength(text)>2*1024*1024)throw new Error('工具结果过大');
    return {content:[{type:'text' as const,text}]};
  });
  return server;
}

/** Authenticated, single-run loopback transport for clients that load HTTP MCP. */
export async function openHttpToolBridge(tools:BridgeTool[],invoke:(name:string,input:unknown,callId:string)=>Promise<unknown>){
  const authorization='Bearer '+randomBytes(32).toString('base64url');
  let open=true,origin='';
  const server=createServer(async(req,res)=>{
    if(!open||!origin||req.headers.authorization!==authorization||req.headers.host!==new URL(origin).host||req.headers.origin){res.writeHead(401).end();return;}
    if(req.url!=='/mcp'){res.writeHead(404).end();return;}
    if(req.method!=='POST'){res.writeHead(405,{Allow:'POST'}).end();return;}
    let mcp:McpServer|undefined;
    try{
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
      const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,maxRequestBodySize:1024*1024});
      mcp=toolServer(tools,(name,input)=>invoke(name,input,'mcp:'+randomUUID()));
      await mcp.connect(transport);
      const headers=new Headers();
      for(const [name,value] of Object.entries(req.headers))if(typeof value==='string')headers.set(name,value);
      const request=new Request(origin+'/mcp',{method:'POST',headers,body:Buffer.concat(chunks)});
      const response=await transport.handleRequest(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    }catch{if(!res.headersSent)res.writeHead(500);res.end();}
    finally{await mcp?.close();}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  if(!address||typeof address==='string'){await closeServer(server);throw new Error('工具桥端口不可用');}
  origin='http://127.0.0.1:'+address.port;
  return {serverUrl:origin+'/mcp',headers:{Authorization:authorization},async close(){open=false;server.closeAllConnections();await closeServer(server);}};
}

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
  const server=toolServer(tools,async(name,input)=>(await bridgeRequest(socket,'/call',{name,input})).output);
  await server.connect(new StdioServerTransport());
}
