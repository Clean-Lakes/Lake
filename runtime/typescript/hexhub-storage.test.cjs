const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs');
const {join}=require('node:path'),{tmpdir}=require('node:os');
const h=require('./hexhub-fixture.cjs'),reader=h.storageModule();
function home(t){const path=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'lake-hexhub-')));t.after(()=>fs.rmSync(path,{recursive:true,force:true}));return path;}
test('HexHub reader resolves current SST/WAL sequences and tombstones without modifying native storage',t=>{
  const base=home(t),root=h.storage(base,[h.sshAsset('a','old','192.0.2.1'),h.sshAsset('b','deleted','192.0.2.2')]);
  fs.writeFileSync(join(root,'000009.ldb'),h.table([[h.assetKey('0'),h.v8(h.sshAsset('a','obsolete','192.0.2.9')),999]]));
  fs.writeFileSync(join(root,'000011.log'),h.journal([h.batch([[h.assetKey('0'),h.v8(h.sshAsset('a','obsolete-log','192.0.2.8'))]],999)]));
  fs.writeFileSync(join(root,'000012.log'),h.journal([h.batch([[h.assetKey('0'),h.v8(h.sshAsset('a','current','192.0.2.1'))],[h.assetKey('1'),null]])]));
  const before=fs.readdirSync(root).map(name=>[name,fs.readFileSync(join(root,name)).toString('hex')]);
  const rows=reader.readHexHubLocalAssets(base);assert.equal(rows.length,1);assert.equal(rows[0].name,'current');
  assert.deepEqual(fs.readdirSync(root).map(name=>[name,fs.readFileSync(join(root,name)).toString('hex')]),before);
  const wal=fs.readFileSync(join(root,'000012.log'));wal[0]^=1;fs.writeFileSync(join(root,'000012.log'),wal);
  assert.throws(()=>reader.readHexHubLocalAssets(base),/本地连接数据/);
});
test('HexHub reader rejects ambiguous stores, symlinks, corrupt SSTs and cancellation',t=>{
  const base=home(t),root=h.storage(base,[h.sshAsset('a','one','192.0.2.1')]);
  const path=join(root,'000010.ldb'),data=fs.readFileSync(path);data[0]^=1;fs.writeFileSync(path,data);assert.throws(()=>reader.readHexHubLocalAssets(base));
  h.storage(base,[]);fs.renameSync(path,path+'.real');fs.symlinkSync(path+'.real',path);assert.throws(()=>reader.readHexHubLocalAssets(base));
  fs.unlinkSync(path);fs.renameSync(path+'.real',path);
  fs.mkdirSync(join(root,'../http_localhost_2222.indexeddb.leveldb'));assert.throws(()=>reader.readHexHubLocalAssets(base));
  const controller=new AbortController();controller.abort();assert.throws(()=>reader.readHexHubLocalAssets(base,controller.signal));
});
test('HexHub V8 envelopes and Snappy enforce format, bounds, cycles and trailing bytes',()=>{
  const object={type:2,name:'中文名称',data:{nested:[true,1,null],date:new Date(0)}};
  const value=h.v8(object);assert.deepEqual(reader.decodeHexHubAsset(value),object);
  const raw=value.subarray(1),length=Buffer.alloc(2);length.writeUInt16LE(raw.length-1);
  const compressed=Buffer.concat([Buffer.from([1,255,17,2]),h.uint(raw.length),Buffer.from([61<<2]),length,raw]);
  assert.deepEqual(reader.decodeHexHubAsset(compressed),object);
  assert.equal(reader.decodeHexHubSnappy(Buffer.from([8,0,97,26,1,0])).toString(),'aaaaaaaa');
  assert.throws(()=>reader.decodeHexHubSnappy(Buffer.from([255,255,255,255,7]),1024));
  for(const bytes of [Buffer.from([1,255,17,1,1,0]),Buffer.from([1,255,16,255,99]),Buffer.concat([value,Buffer.from([0])])])assert.throws(()=>reader.decodeHexHubAsset(bytes));
  const cycle={};cycle.self=cycle;assert.throws(()=>reader.decodeHexHubAsset(h.v8(cycle)));
});
