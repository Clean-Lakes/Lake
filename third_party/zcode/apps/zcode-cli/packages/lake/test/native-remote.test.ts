import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import ssh2 from "ssh2";
const {Server,utils}=ssh2;
import { SSHBackend } from "../../../../../packages/server/src/remote/ssh-backend.ts";

test("native SSH rejects changed host identity and routes two independent loopback forwards",{timeout:15000},async()=>{
 const privateKey=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs1",format:"pem"});
 const parsed=utils.parseKey(privateKey);assert(!(parsed instanceof Error));const publicKey=parsed.getPublicSSH();
 let peer;let nextPort=31000;
 const server=new Server({hostKeys:[privateKey]},client=>{
  peer=client;client.on("error",()=>{});client.on("authentication",ctx=>ctx.accept());
  client.on("ready",()=>client.on("request",(accept,_reject,name)=>{if(name === "tcpip-forward") accept?.(nextPort++);else accept?.();}));
 });
 server.listen(0,"127.0.0.1");await once(server,"listening");
 const gateways=["first","second"].map(marker=>createServer((_req,res)=>res.end(marker)));
 for(const gateway of gateways){gateway.listen(0,"127.0.0.1");await once(gateway,"listening");}
 const backend=new SSHBackend({host:"127.0.0.1",port:(server.address() as {port:number}).port,username:"fixture",agent:"",password:"synthetic",hostVerifier:actual=>Buffer.isBuffer(actual) && actual.equals(publicKey)});
 const bad=new SSHBackend({host:"127.0.0.1",port:(server.address() as {port:number}).port,username:"fixture",agent:"",password:"synthetic",hostVerifier:()=>false});
 try{
  await assert.rejects(bad.forwardLocal(1));bad.dispose();
  const forwards=[];for(const gateway of gateways) forwards.push(await backend.forwardLocal((gateway.address() as {port:number}).port));
  for(let i=0;i<forwards.length;i++){
   const response=await new Promise<string>((resolve,reject)=>peer.forwardOut("127.0.0.1",forwards[i].port,"127.0.0.1",32000+i,(error,stream)=>{if(error){reject(error);return;}let output="";stream.on("data",chunk=>{output+=chunk;});stream.on("error",reject);stream.on("end",()=>resolve(output));stream.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");}));
   assert(response.endsWith(i===0?"first":"second"));
  }
  forwards[0].dispose();forwards[0].dispose();forwards[1].dispose();
 }finally{bad.dispose();backend.dispose();peer?.end();await new Promise<void>(resolve=>server.close(()=>resolve()));for(const gateway of gateways){gateway.closeAllConnections();await new Promise<void>(resolve=>gateway.close(()=>resolve()));}}
});
