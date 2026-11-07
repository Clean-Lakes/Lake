import {test} from "node:test";
import assert from "node:assert/strict";
import {networkProbe, authorizeNetworkProbe} from "./network-probe";

const request = "Check https://qa.example.org:443/status/204 at 8.8.8.8, using bad-qa.invalid for the certificate control.";
const parameters = {hostname:"qa.example.org", ipv4:"8.8.8.8", port:443, path:"/status/204", negative_hostname:"bad-qa.invalid"};

test("only the named user endpoint and explicit network operations are admitted",()=>{
  const probe = networkProbe("https",parameters);
  authorizeNetworkProbe(probe,[request]);
  for (const text of [request.replace("8.8.8.8","18.8.8.8"),request.replace("/204","/204/details"),
    request.replace("qa.example.org:","other-qa.example.org:"),request.replace("https:","http:"),
    request.replace("bad-qa.invalid","foreign.invalid")]) {
    assert.throws(()=>authorizeNetworkProbe(probe,[text]));
  }
  assert.throws(()=>authorizeNetworkProbe(probe,["8.8.8.8",request.replace("8.8.8.8","")]));
  assert.throws(()=>networkProbe("https",{...parameters,headers:{Authorization:"x"}}));
  assert.throws(()=>networkProbe("https",{...parameters,negative_hostname:"other.example.org"}));
});

test("only canonical A names, public destinations and simple absolute paths are accepted",()=>{
  const dns = networkProbe("dns_a",{hostname:"Origin.Example.org."});
  assert.equal(dns?.hostname,"origin.example.org");
  authorizeNetworkProbe(dns,["Look up origin.example.org."]);
  assert.throws(()=>authorizeNetworkProbe(networkProbe("dns_a",{hostname:"unexpected.invalid"}),["check DNS"]));
  for (const hostname of ["-a.test","x..test","a.test\nwhoami","a.test/","127.0.0.1","user@a.test"])
    assert.throws(()=>networkProbe("dns_a",{hostname}));
  for (const ipv4 of ["::1","127.0.0.1","169.254.169.254","10.0.0.1","172.31.0.1","192.168.1.1","0.0.0.0","100.64.0.1","192.0.2.1","198.18.0.1","255.255.255.255"])
    assert.throws(()=>networkProbe("https",{...parameters,ipv4}));
  for (const path of ["https://x.test/","//other","/../secret","/a?token=x","/a%0d%0aX:foo"])
    assert.throws(()=>networkProbe("https",{...parameters,path}));
  assert.throws(()=>networkProbe("dns_a",{hostname:"x.test",resolver:"8.8.8.8"}));
});

test("the fixed remote program hashes complete bodies only and never fetches the negative name",async()=>{
  const {spawnSync}=await import("node:child_process");
  const {networkProbeProgram}=await import("./network-probe");
  const check=String.raw`
class Socket:
    def getsockname(self): return ('1.1.1.1',1000)
    def getpeername(self): return ('8.8.8.8',443)
    def getpeercert(self): return {'subjectAltName':[('DNS','qa.example.org')]}
    def sendall(self,data): sent.append(data)
    def close(self): pass
class Context:
    check_hostname=True
    verify_mode=ssl.CERT_REQUIRED
    def wrap_socket(self,sock,server_hostname): return sock
class Response:
    status=204
    length=0
    body=b''
    def __init__(self,sock): pass
    def begin(self): pass
    def read(self,limit): return self.body[:limit]
socket.create_connection=lambda *a,**kw: Socket()
ssl.create_default_context=Context
http.HTTPResponse=Response
target=dict(hostname='qa.example.org',ipv4='8.8.8.8',port=443,path='/status/204'); sent=[]
assert https(target,target['hostname'])['bodySHA256']==hashlib.sha256(b'').hexdigest()
assert len(sent)==1 and sent[0].startswith(b'GET /status/204 HTTP/1.1')
sent=[]
assert https(target,'bad.invalid')['tlsVerified'] and not sent
Response.body=b'a'*65537
r=https(target,target['hostname']); assert r['bodyLimitExceeded'] and 'bodySHA256' not in r
Response.body=b'partial'; Response.length=123
r=https(target,target['hostname']); assert r['incompleteBody'] and 'bodySHA256' not in r
`;
  const source=networkProbeProgram.replace("main(json.loads(sys.argv[1]))",check);
  const run=spawnSync("python3",["-EsSB","-c",source],{encoding:"utf8"});
  assert.equal(run.status,0,run.stderr);
});
