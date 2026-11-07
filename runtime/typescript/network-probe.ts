import {isIPv4} from "node:net";
import {HttpError} from "./store";

function invalid(message: string): never { throw new HttpError(400, message); }

function hostname(value: unknown) {
  if (typeof value !== "string") invalid("需要明确的 DNS 主机名");
  const name = value.toLowerCase().replace(/\.$/, "");
  if (name.length > 253 || !name.includes(".") || !name.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || /^[\d.]+$/.test(name))
    invalid("DNS 名称格式无效");
  return name;
}

function publicAddress(value: unknown) {
  if (typeof value !== "string" || !isIPv4(value)) invalid("HTTPS 需要明确的公网 IPv4");
  const [a,b,c] = value.split(".").map(Number);
  if ([0,10,127].includes(a) || a >= 224 || a===100 && b>=64 && b<=127 ||
      a===169 && b===254 || a===172 && b>=16 && b<=31 || a===192 && (b===168 ||
        b===0 && [0,2].includes(c) || b===88 && c===99) ||
      a===198 && ([18,19].includes(b) || b===51 && c===100) || a===203 && b===0 && c===113)
    invalid("HTTPS 诊断只接受公网单播 IPv4");
  return value;
}

export function networkProbe(metric: string, input: unknown) {
  if (metric !== "dns_a" && metric !== "https") return;
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("网络诊断需要 network_probe");
  const args = input as Record<string,unknown>;
  const keys = metric === "dns_a" ? ["hostname"] : ["hostname","ipv4","port","path","negative_hostname"];
  if (Object.keys(args).some(key => !keys.includes(key))) invalid("不支持此网络探测参数");
  const host = hostname(args.hostname);
  if (metric === "dns_a") return {metric, hostname:host};
  const ip = publicAddress(args.ipv4), port = args.port ?? 443, path = args.path ?? "/";
  if (typeof port !== "number" || !Number.isInteger(port) || port<1 || port>65535) invalid("HTTPS 端口无效");
  if (typeof path !== "string" || path.length>256 || !/^\/(?:[a-zA-Z0-9_~.-]+\/)*[a-zA-Z0-9_~.-]*$/.test(path) ||
      path.split("/").some(p=>p==="." || p==="..")) invalid("HTTPS 路径仅支持简单绝对路径");
  const negative = args.negative_hostname === undefined ? undefined : hostname(args.negative_hostname);
  if (negative && !negative.endsWith(".invalid")) invalid("对照名称需位于 .invalid");
  return {metric, hostname:host, ipv4:ip, port, path, negative_hostname:negative};
}

export function authorizeNetworkProbe(probe: ReturnType<typeof networkProbe>, requests: string[]) {
  if (!probe) return;
  // Match whole endpoint tokens in a single actual human message. Worker summaries,
  // tool output and separate messages cannot combine to grant a new destination.
  const escaped = (s: string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const ipOrName = (s: string)=>new RegExp("(?<![a-z0-9_.@/-])"+escaped(s)+"(?:\\.(?![a-z0-9_.-]))?(?![a-z0-9_-]|\\.[a-z0-9.-])","i");
  if (probe.metric==="dns_a") {
    if (!probe.hostname.endsWith(".invalid") && !requests.some(text=>ipOrName(probe.hostname).test(text)))
      throw new HttpError(403,"DNS 查询名称须来自本任务的用户输入");
    return;
  }
  const port = probe.port===443 ? "(?::443)?" : ":"+probe.port;
  const endpoint = new RegExp("(?<![a-z0-9_./%@-])(?:https://)?"+escaped(probe.hostname)+port+
    escaped(probe.path!)+"(?![a-z0-9_~.%/?#@=&:-])","i");
  if (!requests.some(text=>ipOrName(probe.ipv4!).test(text) && endpoint.test(text) &&
      (!probe.negative_hostname || probe.negative_hostname==="lake-name-check.invalid" || ipOrName(probe.negative_hostname).test(text))))
    throw new HttpError(403,"HTTPS 域名、端口、路径与固定 IP 须来自本任务同一条用户输入");
}

// Runs with a fixed argv on the SSH host using its OS Python 2.7 / 3 and trust
// store. All requests have a wall-clock limit, and no body or headers are exposed.
export const networkProbeProgram = String.raw`
from __future__ import print_function
import datetime, hashlib, json, os, pwd, re, signal, socket, ssl, struct, subprocess, sys, time
try:
    import http.client as http
except ImportError:
    import httplib as http
def now():
    return datetime.datetime.utcnow().isoformat() + 'Z'
def u16(data, offset):
    return struct.unpack_from('!H', data, offset)[0]
def skip_name(data, offset):
    for _ in range(128):
        n = ord(data[offset:offset+1])
        if n & 192 == 192:
            if offset+2 > len(data): raise ValueError('bad DNS pointer')
            return offset+2
        if n>63 or offset+n+1 > len(data): raise ValueError('bad DNS name')
        offset += n+1
        if not n: return offset
    raise ValueError('bad DNS length')
def recv_exact(sock, count):
    chunks = []
    while count:
        part = sock.recv(count)
        if not part: raise IOError('incomplete DNS reply')
        count -= len(part)
        chunks.append(part)
    return b''.join(chunks)
def dns(name):
    with open('/etc/resolv.conf') as f:
        servers = [s[1] for s in (line.split() for line in f) if len(s)>=2 and s[0]=='nameserver'][:3]
    last = 'no configured resolver'
    for server in servers:
        start = time.time()
        family = socket.AF_INET6 if ':' in server else socket.AF_INET
        try:
            socket.inet_pton(family,server)
            ident = os.urandom(2)
            q = b''.join(struct.pack('B',len(s))+s.encode('ascii') for s in name.split('.'))+b'\0\0\1\0\1'
            packet = ident+struct.pack('!HHHHH',256,1,0,0,0)+q
            def check(data):
                if len(data)<12 or data[:2]!=ident or not u16(data,2)&32768 or u16(data,4)!=1:
                    raise ValueError('invalid DNS reply')
                n=skip_name(data,12)+4
                if data[12:n].lower()!=q: raise ValueError('DNS question mismatch')
                return n
            sock=socket.socket(family,socket.SOCK_DGRAM)
            try:
                sock.settimeout(2); sock.connect((server,53)); sock.send(packet); data=sock.recv(65535)
            finally: sock.close()
            check(data)
            if u16(data,2)&512:
                sock=socket.socket(family,socket.SOCK_STREAM)
                try:
                    sock.settimeout(2); sock.connect((server,53)); sock.sendall(struct.pack('!H',len(packet))+packet)
                    data=recv_exact(sock,u16(recv_exact(sock,2),0))
                finally: sock.close()
            offset=check(data); answers=[]
            for _ in range(u16(data,6)):
                offset=skip_name(data,offset)
                typ,cls,ttl,size=struct.unpack_from('!HHIH',data,offset); offset+=10
                if offset+size>len(data): raise ValueError('truncated DNS data')
                if typ==1 and cls==1 and size==4 and len(answers)<32:
                    answers.append(socket.inet_ntoa(data[offset:offset+4]))
                offset+=size
            code=u16(data,2)&15
            return dict(hostname=name,query='A',server=server,rcode={0:'NOERROR',1:'FORMERR',2:'SERVFAIL',3:'NXDOMAIN',5:'REFUSED'}.get(code,str(code)),answers=answers,elapsedMs=round((time.time()-start)*1000,2))
        except (ValueError,IndexError,TypeError,struct.error,IOError) as e: last=str(e)[:180]
    return dict(hostname=name,query='A',error=last)
def https(target, name):
    start=time.time(); sock=None; tls=None; stage='tcp'
    result=dict(hostname=name,at=now())
    try:
        sock=socket.create_connection((target['ipv4'],target['port']),3)
        result.update(source=sock.getsockname()[0],peer=sock.getpeername()[0],tcpMs=round((time.time()-start)*1000,2))
        stage='tls'
        context=ssl.create_default_context()
        if not context.check_hostname or context.verify_mode!=ssl.CERT_REQUIRED:
            raise ValueError('verified TLS unavailable')
        tls=context.wrap_socket(sock,server_hostname=name)
        cert=tls.getpeercert()
        result.update(tlsVerified=True,certificateDNS=[v for k,v in cert.get('subjectAltName',[]) if k=='DNS' and len(v)<=253][:12])
        # The negative control only performs the authenticated TLS handshake.
        if name!=target['hostname']:
            result['elapsedMs']=round((time.time()-start)*1000,2)
            return result
        stage='http'
        authority=name if target['port']==443 else name+':'+str(target['port'])
        tls.sendall(('GET '+target['path']+' HTTP/1.1\r\nHost: '+authority+'\r\nConnection: close\r\n\r\n').encode('ascii'))
        response=http.HTTPResponse(tls); response.begin(); result['httpStatus']=response.status
        body=response.read(65537)
        if len(body)>65536: result['bodyLimitExceeded']=True
        elif response.length not in (0,None): result['incompleteBody']=True
        else: result.update(bodyBytes=len(body),bodySHA256=hashlib.sha256(body).hexdigest())
    except Exception as e:
        error=str(e)[:240]; code=getattr(e,'verify_code',None)
        mismatch=code==62 or bool(re.search(r"hostname.*(doesn.t match|mismatch|not valid)|IP address mismatch",error,re.I))
        result.update(errorStage=stage,errorType=type(e).__name__,hostnameMismatch=mismatch)
        if code is not None: result['verificationCode']=code
    finally:
        if tls: tls.close()
        if sock: sock.close()
    result['elapsedMs']=round((time.time()-start)*1000,2)
    return result
def main(target):
    signal.alarm(24)
    os.chdir('/')
    if os.getuid()==0:
        nobody=pwd.getpwnam('nobody'); os.setgroups([]); os.setgid(nobody.pw_gid); os.setuid(nobody.pw_uid)
    output=dict(observedAt=now(),uid=os.getuid(),dns=dns(target['hostname']))
    if target['metric']=='https':
        ip=target['ipv4']
        for routecmd in ['/usr/sbin/ip','/sbin/ip','/usr/bin/ip','/bin/ip']:
            if os.path.isfile(routecmd):
                p=subprocess.Popen([routecmd,'-4','route','get',ip],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                stdout,_=p.communicate()
                if p.returncode==0: output['route']=stdout[:1024].decode('ascii','replace').strip()
                break
        output['primary']=https(target,target['hostname'])
        if target.get('negative_hostname'):
            output['negative']=https(target,target['negative_hostname']); output['retest']=https(target,target['hostname'])
    print(json.dumps(output,sort_keys=True))
main(json.loads(sys.argv[1]))
`;

export const networkProbeShell = 'cd / || exit 1\npy=$(command -v python3 || command -v python) || { echo "system Python unavailable" >&2; exit 69; }\nexec "$py" -E -s -S -B -c "$1" "$2"';
