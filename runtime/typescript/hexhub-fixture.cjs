const fs = require('node:fs');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {serialize} = require('node:v8');
const {createCipheriv} = require('node:crypto');
const uint = value => {let n=BigInt(value),out=[];do{let b=Number(n&127n);n>>=7n;out.push(b|(n?128:0));}while(n);return Buffer.from(out);};
const field = value => Buffer.concat([uint(value.length),value]);
function crc(data) {let value=0xffffffff;for(const byte of data){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?(value>>>1)^0x82f63b78:value>>>1;}value=(value^0xffffffff)>>>0;return (((value>>>15)|(value<<17))+0xa282ead8)>>>0;}
function journal(records) {return Buffer.concat(records.map(data=>{if(data.length>32761)throw Error('fixture fragment required');const header=Buffer.alloc(7);header.writeUInt32LE(crc(Buffer.concat([Buffer.from([1]),data])));header.writeUInt16LE(data.length,4);header[6]=1;return Buffer.concat([header,data]);}));}
function block(entries) {const rows=entries.map(([key,value])=>Buffer.concat([uint(0),uint(key.length),uint(value.length),key,value])),end=Buffer.alloc(8);end.writeUInt32LE(1,4);return Buffer.concat([...rows,end]);}
function trailer(data) {const tail=Buffer.alloc(5);tail.writeUInt32LE(crc(Buffer.concat([data,Buffer.from([0])])),1);return Buffer.concat([data,tail]);}
function table(entries) {
  const data=block(entries.map(([key,value,seq=1,deleted=false])=>{const tag=Buffer.alloc(8);tag.writeBigUInt64LE(BigInt(seq)*256n+(deleted?0n:1n));return [Buffer.concat([key,tag]),value];}));
  const index=block([[Buffer.from('index'),Buffer.concat([uint(0),uint(data.length)])]]),footer=Buffer.alloc(48);
  Buffer.concat([uint(0),uint(0),uint(data.length+5),uint(index.length)]).copy(footer);footer.writeBigUInt64LE(0xdb4775248b80fb57n,40);
  return Buffer.concat([trailer(data),trailer(index),footer]);
}
const v8 = value => Buffer.concat([Buffer.from([1,255,21,254]),Buffer.alloc(12),serialize(value)]);
const metadata = Buffer.from([0,1,0,0,50,1,0]);
const assetKey = name => Buffer.concat([Buffer.from([0,1,1,1,1]),Buffer.from(name)]);
function batch(entries, sequence=20) {const header=Buffer.alloc(12);header.writeBigUInt64LE(BigInt(sequence));header.writeUInt32LE(entries.length,8);return Buffer.concat([header,...entries.map(([key,value])=>Buffer.concat([Buffer.from([value===null?0:1]),field(key),...(value===null?[]:[field(value)])]))]);}
function storage(home, assets=[]) {
  const root=join(home,'.hexhub/cache/Default/IndexedDB/http_localhost_1234.indexeddb.leveldb');fs.mkdirSync(root,{recursive:true,mode:0o700});
  const entries=[[metadata,Buffer.from('assets','utf16le').swap16(),1],...assets.map((asset,index)=>[assetKey(String(index)),v8(asset),index+2])];
  fs.writeFileSync(join(root,'000010.ldb'),table(entries));
  const manifest=Buffer.concat([Buffer.from([1]),field(Buffer.from('idb_cmp1')),Buffer.from([2,12,7,0,10,1]),field(Buffer.from('min')),field(Buffer.from('max'))]);
  fs.writeFileSync(join(root,'MANIFEST-000001'),journal([manifest]));fs.writeFileSync(join(root,'CURRENT'),'MANIFEST-000001\n');
  return root;
}
function encrypted(text) {const cipher=createCipheriv('aes-128-cbc',Buffer.from('CsN#&Uc!aOUQbh&B'),Buffer.from('w6KQ^MPlEx*mfHcb'));return Buffer.concat([cipher.update(text),cipher.final()]).toString('base64');}
const sshAsset = (id,name,host,password='synthetic-hexhub-password',extra={}) => ({id,type:2,name,dirPath:'/现场/',data:{host,port:22,user:'root',authType:0,password:encrypted(password),...extra}});
function storageModule() {
  const directory=fs.mkdtempSync(join(tmpdir(),'lake-reader-test-'));
  try{const {buildSync}=require('../../third_party/agent-sdk/node_modules/esbuild');const path=join(directory,'reader.cjs');buildSync({entryPoints:[join(__dirname,'hexhub-storage.ts')],bundle:true,platform:'node',format:'cjs',outfile:path,logLevel:'silent'});return require(path);}finally{fs.rmSync(directory,{recursive:true,force:true});}
}
module.exports={uint,field,crc,journal,table,v8,metadata,assetKey,batch,storage,encrypted,sshAsset,storageModule};
