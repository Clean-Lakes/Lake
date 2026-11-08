import { isIP } from "node:net";
import { HttpError } from "./store";

export function directoryStateRoot(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\/tmp\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,80}$/.test(value)
  )
    throw new HttpError(400, "目录状态需要明确的单层 /tmp 私有目录");
  return value;
}

const sha256 = /^[a-f0-9]{64}$/;
const size = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= max;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const digest = (value: unknown) =>
  typeof value === "string" && sha256.test(value);
const relativePath = (value: unknown) =>
  typeof value === "string" &&
  (value === "." ||
    (value.length > 0 &&
      !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) &&
      value
        .split("/")
        .every((part) => part.length > 0 && part !== "." && part !== "..")));

function validEntry(entry: unknown, complete: boolean) {
  if (
    !object(entry) ||
    !relativePath(entry.path) ||
    !size(entry.uid) ||
    !size(entry.gid) ||
    !size(entry.mode, 0o7777) ||
    !size(entry.size) ||
    !size(entry.ino) ||
    !Number.isSafeInteger(entry.mtimeUs)
  )
    return false;
  switch (entry.type) {
    case "file":
      return !complete || digest(entry.sha256);
    case "directory":
      return !complete || digest(entry.treeSha256);
    case "symlink":
      return !complete || digest(entry.targetSha256);
    default:
      return ["fifo", "character", "block", "socket"].includes(
        String(entry.type),
      );
  }
}

function validProcess(value: unknown, uid: number, directory: string) {
  if (
    !object(value) ||
    !size(value.pid) ||
    !value.pid ||
    !size(value.startTicks) ||
    !size(value.ppid) ||
    value.uid !== uid ||
    typeof value.cwd !== "string" ||
    !(
      value.cwd === directory ||
      value.cwd.startsWith(directory + "/") ||
      value.cwd === "[outside directory]"
    ) ||
    typeof value.cwdDeleted !== "boolean" ||
    !digest(value.argvSha256) ||
    !Array.isArray(value.argv) ||
    !value.argv.length ||
    value.argv.length > 128 ||
    !value.argv.every((arg) => typeof arg === "string" && arg.length <= 512) ||
    !Array.isArray(value.tcpListeners) ||
    value.tcpListeners.length > 128
  )
    return false;
  return value.tcpListeners.every(
    (item) =>
      object(item) &&
      typeof item.address === "string" &&
      isIP(item.address) > 0 &&
      size(item.port, 65535) &&
      item.port > 0,
  );
}

export function validateDirectoryState(output: string, directory: string) {
  const invalid = () =>
    new HttpError(502, "目录状态回执缺少有效的目标或覆盖信息");
  if (Buffer.byteLength(output) > 131072) throw invalid();
  let data;
  try {
    data = JSON.parse(output);
  } catch {
    throw new HttpError(502, "目录状态回执不是完整 JSON");
  }
  if (
    !object(data) ||
    data.schemaVersion !== 1 ||
    data.directory !== directory ||
    !size(data.uid) ||
    data.uid === 0 ||
    typeof data.complete !== "boolean" ||
    !(data.present === null || typeof data.present === "boolean") ||
    !size(data.entryCount, 8192) ||
    !size(data.hashedBytes, 256 * 1024 * 1024) ||
    data.displayDepth !== 3 ||
    !(data.treeSha256 === null || digest(data.treeSha256)) ||
    !Array.isArray(data.issues) ||
    data.issues.length > 16 ||
    !data.issues.every(
      (value) => typeof value === "string" && value.length <= 200,
    ) ||
    !Array.isArray(data.entries) ||
    data.entries.length > 384 ||
    data.entries.length > data.entryCount ||
    !Array.isArray(data.processes) ||
    data.processes.length > 64 ||
    typeof data.startedAt !== "string" ||
    typeof data.observedAt !== "string" ||
    !Number.isFinite(Date.parse(data.startedAt)) ||
    !(Date.parse(data.observedAt) >= Date.parse(data.startedAt))
  )
    throw invalid();
  const { uid, complete, entries, processes } = data;
  if (
    entries.some((entry) => !validEntry(entry, complete)) ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length ||
    processes.some((proc) => !validProcess(proc, uid, directory)) ||
    new Set(processes.map((proc) => proc.pid)).size !== processes.length ||
    complete !== !data.issues.length
  )
    throw invalid();
  if (
    complete &&
    (data.present === null ||
      (data.present
        ? !digest(data.treeSha256) ||
          !entries.some(
            (entry) =>
              entry.path === "." &&
              entry.type === "directory" &&
              entry.uid === uid &&
              entry.mode === 0o700 &&
              entry.treeSha256 === data.treeSha256,
          )
        : data.treeSha256 !== null ||
          data.entryCount !== 0 ||
          entries.length !== 0 ||
          data.hashedBytes !== 0))
  )
    throw invalid();
  return output;
}

// A fixed program; only the validated directory is an argument. Linux O_PATH
// pins the object before opening it for content, even if a directory entry is
// replaced with a device, FIFO or symlink. System Python 2.7 and 3 are supported.
export const directoryStateProgram = String.raw`
from __future__ import print_function
import binascii, ctypes, datetime, errno, fcntl, hashlib, json, os, pwd, re, resource, signal, socket, stat, sys, unicodedata
def stamp(): return datetime.datetime.utcnow().isoformat()+'Z'
root=sys.argv[1]
uid=os.geteuid()
if uid==0 or pwd.getpwuid(uid).pw_name!='nobody' or not sys.platform.startswith('linux'):
    sys.exit('Linux unprivileged observer unavailable')
os.chdir('/')
class TimeLimit(BaseException): pass
def timeout(_sig,_frame): raise TimeLimit()
signal.signal(signal.SIGALRM,timeout); signal.alarm(22)
soft,hard=resource.getrlimit(resource.RLIMIT_AS)
if soft==resource.RLIM_INFINITY or soft>192*1024*1024: resource.setrlimit(resource.RLIMIT_AS,(192*1024*1024,hard))
result=dict(schemaVersion=1,directory=root,uid=uid,startedAt=stamp(),complete=True,issues=[],present=None,treeSha256=None,
            entryCount=0,hashedBytes=0,displayDepth=3,entries=[],processes=[])
def issue(text):
    result['complete']=False
    if text not in result['issues'] and len(result['issues'])<16: result['issues'].append(text)
def enc(obj): return json.dumps(obj,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode('ascii')
def sha(data): return hashlib.sha256(data).hexdigest()
def pathname(fd, name=None):
    path=b'/proc/self/fd/%d'%fd
    return path if name is None else path+b'/'+name
pathflag=getattr(os,'O_PATH',0o10000000)
def pin(path):
    fd=os.open(path,pathflag|os.O_NOFOLLOW)
    if not fcntl.fcntl(fd,fcntl.F_GETFL)&pathflag:
        os.close(fd); raise RuntimeError('missing O_PATH')
    return fd
def mount(fd):
    with open('/proc/self/fdinfo/%d'%fd) as f:
        for line in f:
            if line.startswith('mnt_id:'): return line.split()[1]
    raise RuntimeError('missing mount ID')
def text(data):
    value=data.decode('utf-8') if isinstance(data,bytes) else data
    if any(unicodedata.category(c).startswith('C') or unicodedata.category(c) in ('Zl','Zp') for c in value):
        raise ValueError('unsupported name')
    return value
def signature(s):
    return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,
            getattr(s,'st_mtime_ns',s.st_mtime),getattr(s,'st_ctime_ns',s.st_ctime))
identities={}
def pinned_link(fd):
    buf=ctypes.create_string_buffer(4097)
    n=ctypes.CDLL(None,use_errno=True).readlinkat(fd,b'',buf,len(buf))
    if n<0 or n>=len(buf):raise RuntimeError('symlink observation unavailable')
    return buf.raw[:n]
def visit(parent,name,rel,depth,mount_id):
    if depth>14 or result['entryCount']>=8192: raise RuntimeError('directory scan limit')
    fd=pin(pathname(parent,name))
    try:
        info=os.fstat(fd); sig=signature(info)
        if mount(fd)!=mount_id: raise RuntimeError('mount boundary')
        identities[rel]=sig
        kinds={stat.S_IFREG:'file',stat.S_IFDIR:'directory',stat.S_IFLNK:'symlink',stat.S_IFIFO:'fifo',
               stat.S_IFCHR:'character',stat.S_IFBLK:'block',stat.S_IFSOCK:'socket'}
        row=dict(path=rel,type=kinds[stat.S_IFMT(info.st_mode)],uid=info.st_uid,gid=info.st_gid,
                 mode=stat.S_IMODE(info.st_mode),size=info.st_size,ino=info.st_ino,mtimeUs=int(info.st_mtime*1000000))
        result['entryCount']+=1
        if depth==0 and (row['type']!='directory' or info.st_uid!=uid or row['mode']!=0o700): raise RuntimeError('root is not a private owned directory')
        if depth<=3:
            if len(result['entries'])>=384: raise RuntimeError('visible entry limit')
            result['entries'].append(row)
        children=hashlib.sha256()
        if row['type']=='directory':
            for child in sorted(os.listdir(pathname(fd))):
                label=text(child); sub=label if rel=='.' else rel+'/'+label
                children.update(enc([label,visit(fd,child,sub,depth+1,mount_id)]))
        elif row['type']=='file':
            if info.st_nlink!=1 or info.st_uid!=uid: raise RuntimeError('untrusted regular file')
            if info.st_size>64*1024*1024 or result['hashedBytes']+info.st_size>256*1024*1024: raise RuntimeError('file hashing limit')
            digest=hashlib.sha256(); length=0
            with open(pathname(fd),'rb') as f:
                if signature(os.fstat(f.fileno()))!=sig: raise RuntimeError('file identity changed')
                while True:
                    chunk=f.read(131072)
                    if not chunk: break
                    length+=len(chunk)
                    if length>info.st_size: raise RuntimeError('file size changed')
                    digest.update(chunk)
            if length!=info.st_size: raise RuntimeError('file size changed')
            result['hashedBytes']+=length; row['sha256']=digest.hexdigest()
        elif row['type']=='symlink':
            target=pinned_link(fd)
            row['targetSha256']=sha(target)
            if not target.startswith(b'/') and b'..' not in target.split(b'/') and re.match(b'^[a-zA-Z0-9_./-]+$',target):
                row['target']=target.decode('ascii')
        if signature(os.fstat(fd))!=sig or signature(os.lstat(pathname(parent,name)))!=sig: raise RuntimeError('directory entry changed')
        digest=sha(enc([row,children.hexdigest()]))
        if row['type']=='directory': row['treeSha256']=digest
        return digest
    finally: os.close(fd)
def under(path):
    return os.path.normpath(path)==path and (path==root or path.startswith(root+'/'))
def limited(path,n):
    with open(path,'rb') as fd: value=fd.read(n+1)
    if len(value)>n: raise RuntimeError('process input limit')
    return value
def procstat(base):
    raw=limited(base+'/stat',4096)
    rest=raw.rsplit(b') ',1)[1].split()
    return int(rest[19]),int(rest[1]),rest[0]
def ports(base):
    inodes=set(); fdnames=os.listdir(base+'/fd')
    if len(fdnames)>4096: raise RuntimeError('socket descriptor limit')
    for f in fdnames:
        try: name=os.readlink(base+'/fd/'+f)
        except OSError as e:
            if e.errno==errno.ENOENT: continue
            raise
        if name.startswith('socket:['): inodes.add(name[8:-1])
    found=[]
    for table in ['tcp','tcp6']:
        try: stream=open(base+'/net/'+table)
        except IOError as e:
            if e.errno==errno.ENOENT and table=='tcp6':continue
            raise
        with stream:
            next(stream)
            for i,line in enumerate(stream):
                if i>=65536: raise RuntimeError('socket table limit')
                bits=line.split()
                if bits[3]!='0A' or bits[9] not in inodes:continue
                address,port=bits[1].split(':'); raw=binascii.unhexlify(address)
                if sys.byteorder=='little': raw=b''.join(raw[k:k+4][::-1] for k in range(0,len(raw),4))
                found.append(dict(address=socket.inet_ntop(socket.AF_INET if table=='tcp' else socket.AF_INET6,raw),port=int(port,16)))
                if len(found)>128: raise RuntimeError('listener limit')
    return sorted(found,key=lambda item:(item['address'],item['port']))
def inspect_pid(pid):
    base='/proc/'+str(pid)
    status=limited(base+'/status',32768)
    uids=re.search(b'(?m)^Uid:\\s*(\\d+)\\s+(\\d+)',status)
    if not uids: raise ValueError('missing process identity')
    if int(uids.group(2))!=uid:return
    ticks,ppid,state=procstat(base)
    if state==b'Z':return
    cwd=os.readlink(base+'/cwd'); deleted=cwd.endswith(' (deleted)')
    if deleted: cwd=cwd[:-10]
    cmd=limited(base+'/cmdline',131072)
    args=cmd.rstrip(b'\0').split(b'\0'); decoded=[x.decode('utf-8','replace') for x in args]
    if not under(cwd) and not any(under(x) for x in decoded):return
    # A path in a different mount namespace or process root does not identify
    # the operator's directory, even if its text is identical.
    if os.readlink(base+'/ns/mnt')!=os.readlink('/proc/self/ns/mnt') or not os.path.samestat(os.stat(base+'/root'),os.stat('/')):
        raise RuntimeError('scoped process has a different filesystem view')
    if len(args)>128:raise RuntimeError('process display limit')
    preview=[]
    for i,arg in enumerate(decoded):
        if under(arg) and re.match(r'^/[a-zA-Z0-9_.+/-]{1,384}$',arg) or arg in ('--','-c','-I','-B','-u'):
            preview.append(arg)
        elif i==0 and re.match(r'^(?:/(?:usr/)?(?:s?bin)/)?[a-zA-Z0-9_.+-]{1,64}$',arg):preview.append(arg)
        else:preview.append('[sha256:'+sha(args[i])+']')
    listeners=ports(base)
    if procstat(base)[:2]!=(ticks,ppid) or limited(base+'/cmdline',131072)!=cmd or os.readlink(base+'/cwd')!=cwd+(' (deleted)' if deleted else ''):
        raise RuntimeError('process identity changed')
    return dict(pid=pid,startTicks=ticks,ppid=ppid,uid=uid,cwd=text(cwd) if under(cwd) else '[outside directory]',
                cwdDeleted=deleted,argv=preview,argvSha256=sha(cmd),tcpListeners=listeners)
def process_snapshot():
    with open('/proc/self/mountinfo') as mounts:
        if any(' - proc ' in row and re.search(r'(?:,| )hidepid=(?!0(?:[, ]|$)|off(?:[, ]|$))',row) for row in mounts):
            raise RuntimeError('restricted process namespace')
    allpids=[int(p) for p in os.listdir('/proc') if p.isdigit()]
    if len(allpids)>8192:raise RuntimeError('process scan limit')
    found=[]
    for pid in sorted(allpids):
        if pid==os.getpid():continue
        try:
            item=inspect_pid(pid)
            if item:
                if len(found)>=64: raise RuntimeError('process display limit')
                found.append(item)
        except (IOError,OSError) as e:
            if e.errno in (errno.ENOENT,errno.ESRCH):
                try:
                    if procstat('/proc/'+str(pid))[2]!=b'Z':issue('process changed while reading')
                except (IOError,OSError) as again:
                    if again.errno not in (errno.ENOENT,errno.ESRCH):issue('process visibility: '+str(again.errno))
            else:issue('process visibility: '+str(e.errno))
    return found
def verify(parent,name,rel,mount_id):
    fd=pin(pathname(parent,name))
    try:
        sig=signature(os.fstat(fd))
        if identities.get(rel)!=sig or mount(fd)!=mount_id:raise RuntimeError('directory identity changed')
        if stat.S_ISDIR(sig[2]):
            for child in os.listdir(pathname(fd)):
                label=text(child)
                verify(fd,child,label if rel=='.' else rel+'/'+label,mount_id)
        if signature(os.fstat(fd))!=sig or signature(os.lstat(pathname(parent,name)))!=sig:
            raise RuntimeError('directory changed during verification')
    finally:os.close(fd)
def collect():
    tmp=pin(b'/tmp')
    try:
        name=os.path.basename(root).encode('ascii')
        try:os.lstat(pathname(tmp,name)); result['present']=True
        except OSError as e:
            if e.errno!=errno.ENOENT:raise
            result['present']=False
        mount_id=mount(tmp)
        if result['present']:result['treeSha256']=visit(tmp,name,'.',0,mount_id)
        result['processes']=process_snapshot()
        if result['present']:verify(tmp,name,'.',mount_id)
        else:
            try:os.lstat(pathname(tmp,name));issue('directory appeared during scan')
            except OSError as e:
                if e.errno!=errno.ENOENT:raise
        if process_snapshot()!=result['processes']:issue('scoped processes or listeners changed')
    finally:os.close(tmp)
try:collect()
except TimeLimit:issue('observation time limit')
except (IOError,OSError) as e:issue('visibility or identity: '+str(e.errno))
except (RuntimeError,ValueError,UnicodeError,KeyError,IndexError,StopIteration,MemoryError) as e:
    issue(str(e) if isinstance(e,RuntimeError) else type(e).__name__)
signal.alarm(0)
result['observedAt']=stamp()
if len(enc(result))>115000:
    issue('serialized evidence limit');result['entries']=[];result['processes']=[]
print(enc(result).decode('ascii'))
`;

export function directoryStateCommand(directory: string) {
  directoryStateRoot(directory);
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const clean = "/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/bin LC_ALL=C";
  const python =
    'cd / || exit 1; if test -x /usr/bin/python3; then py=/usr/bin/python3; else py=/usr/bin/python; fi; exec "$py" -EsSB -c "$1" "$2"';
  const start =
    'cd / || exit 1; if test "$(/usr/bin/id -u)" = 0; then exec /usr/sbin/runuser -u nobody -- ' +
    clean +
    ' /bin/sh -c "$1" lake-state "$2" "$3"; fi; exec /bin/sh -c "$1" lake-state "$2" "$3"';
  return (
    clean +
    " /bin/sh -c " +
    quote(start) +
    " lake-state " +
    quote(python) +
    " " +
    quote(directoryStateProgram) +
    " " +
    quote(directory)
  );
}
