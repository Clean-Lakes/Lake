const quote = (text: string) => "'"+text.replaceAll("'","'\"'\"'")+"'";
const rootPattern = /^\/tmp\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$/;
const guard = 'case "$port" in *[!0-9]*|"") exit 1;; esac';

export function serviceInspectionSource(directory: string) {
  return "cd /tmp && runuser -u nobody -- /bin/bash -c 'set -eu; cd "+directory+
    '; printf "current="; readlink current; printf "pid="; /bin/cat shared/app.pid; printf "port="; /bin/cat shared/port.live; '+
    'printf "\\nprocess:\\n"; pid=$(/bin/cat shared/app.pid); ps -p "$pid" -o pid=,user=,lstart=,args=; '+
    'port=$(/bin/cat shared/port.live); '+guard+'; printf "listener:\\n"; ss -ltnp "sport = :$port"; '+
    'printf "scoped processes:\\n"; ps -u nobody -o pid=,lstart=,args= | /bin/grep -F "'+directory+'/shared" | /bin/grep -v grep'+ "'";
}

// Parse just the complete service snapshot. printf labels are optional literals;
// arguments, pipelines, substitutions and the port guard keep their exact roles.
// The source is never sent to the SSH shell by this profile.
function inspectionRoot(source: string) {
  if (source.length>8192 || /[\r\n\0]/.test(source)) return;
  const outer=/^(?:cd \/tmp && )?(?:\/(?:usr\/)?sbin\/)?runuser -u nobody -- \/bin\/(?:ba)?sh -c '([^']+)'$/.exec(source);
  if (!outer) return;
  // Protect the only admitted case terminator before splitting the statements.
  if (!outer[1]!.includes(guard) || outer[1]!.includes("@port_guard")) return;
  const parts=outer[1]!.replace(guard,"@port_guard").split(";").map(s=>s.trim())
    .filter(s=>!/^printf "(?:[A-Za-z0-9 _:=-]|\\n){1,64}"$/.test(s));
  if(parts[0]==="set -eu") parts.shift();
  const directory=/^cd (\S+)$/.exec(parts.shift()??"")?.[1];
  if(!directory || !rootPattern.test(directory)) return;
  const allowed=[
    /^readlink current$/,
    /^(?:\/bin\/|\/usr\/bin\/)?cat shared\/app\.pid$/,
    /^(?:\/bin\/|\/usr\/bin\/)?cat shared\/port\.live$/,
    /^pid=\$\((?:\/bin\/|\/usr\/bin\/)?cat shared\/app\.pid\)$/,
    /^(?:\/bin\/|\/usr\/bin\/)?ps (?:-ww )?-p "\$pid" -o pid=,user=,lstart=,args=$/,
    /^port=\$\((?:\/bin\/|\/usr\/bin\/)?cat shared\/port\.live\)$/,
    /^@port_guard$/,
    /^(?:\/usr\/sbin\/|\/sbin\/)?ss -ltnp "sport = :\$port"$/,
  ];
  const last=parts.pop();
  if (parts.length!==allowed.length || parts.some((s,i)=>!allowed[i]!.test(s))) return;
  if (!last || !['ps -u nobody','ps -ww -u nobody'].some(ps=>
    last===ps+' -o pid=,lstart=,args= | /bin/grep -F "'+directory+'/shared" | /bin/grep -v grep')) return;
  return directory;
}

// Linux /proc is used on both system Python 2.7 and 3. No shell executes inside
// this program. Only owner-private pinned files, the inspected PID's own socket,
// and matching release paths are exposed; arbitrary process arguments are not.
const serviceProbe = String.raw`
import binascii, json, os, pwd, re, signal, socket, stat, subprocess, sys
signal.alarm(12)
root=sys.argv[1]
uid=os.geteuid()
if uid==0 or pwd.getpwuid(uid).pw_name!='nobody': sys.exit('wrong service observer')
def mnt(fd):
    with open('/proc/self/fdinfo/%d'%fd) as f:
        return next(line.split()[1] for line in f if line.startswith('mnt_id:'))
def at(fd,name): return '/proc/self/fd/%d/%s'%(fd,name)
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
tmp=os.open('/tmp',os.O_DIRECTORY|os.O_RDONLY)
rootfd=os.open(at(tmp,os.path.basename(root)),flags|os.O_DIRECTORY)
rootinfo=os.fstat(rootfd); mount=mnt(tmp)
if rootinfo.st_uid!=uid or stat.S_IMODE(rootinfo.st_mode)!=0o700 or mnt(rootfd)!=mount: sys.exit('untrusted service root')
shared=os.open(at(rootfd,'shared'),flags|os.O_DIRECTORY)
if os.fstat(shared).st_uid!=uid or mnt(shared)!=mount: sys.exit('untrusted service directory')
def number(name,upper):
    fd=os.open(at(shared,name),flags)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=uid or s.st_nlink!=1 or s.st_size>24 or mnt(fd)!=mount:
            raise ValueError('invalid service metadata')
        value=os.read(fd,25).decode('ascii').strip()
        if not re.match(r'^[1-9][0-9]{0,7}$',value) or int(value)>upper: raise ValueError('invalid service number')
        return int(value)
    finally: os.close(fd)
link=os.readlink(at(rootfd,'current'))
if not re.match(r'^releases/[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$',link): sys.exit('unrecognized service release')
pid=number('app.pid',4194304); port=number('port.live',65535)
def identity(n):
    proc='/proc/%d'%n
    if os.stat(proc).st_uid!=uid: return
    cwd=os.readlink(proc+'/cwd')
    if cwd!=root or not os.path.samestat(os.stat(proc+'/cwd'),rootinfo): return
    with open(proc+'/cmdline','rb') as f: raw=f.read(8193)
    if len(raw)>8192: return
    argv=[a.decode('utf-8','replace') for a in raw.split(b'\0')]
    if root+'/shared' not in argv: return
    with open(proc+'/stat') as f: ticks=int(f.read().rsplit(') ',1)[1].split()[19])
    for arg in argv[:4]:
        script=os.path.normpath(os.path.join(cwd,arg))
        if script.startswith(root+'/'+link+'/') and re.match(r'^[A-Za-z0-9_.-]+$',os.path.basename(script)):
            return n,ticks,script
original=identity(pid)
if not original: sys.exit('PID does not belong to service')
ps='/bin/ps' if os.path.exists('/bin/ps') else '/usr/bin/ps'
when=subprocess.check_output([ps,'-ww','-p',str(pid),'-o','lstart=']).decode('ascii').strip()
sock=set()
for name in os.listdir('/proc/%d/fd'%pid):
    try:
        target=os.readlink('/proc/%d/fd/%s'%(pid,name))
        if target.startswith('socket:['): sock.add(target[8:-1])
    except OSError: pass
listeners=set()
for table in ['tcp','tcp6']:
    try:
        with open('/proc/%d/net/%s'%(pid,table)) as f:
            next(f)
            for line in f:
                c=line.split()
                address,raw_port=c[1].split(':')
                if c[3]!='0A' or int(raw_port,16)!=port or c[9] not in sock: continue
                raw=binascii.unhexlify(address)
                if sys.byteorder=='little': raw=b''.join(raw[i:i+4][::-1] for i in range(0,len(raw),4))
                listeners.add(socket.inet_ntop(socket.AF_INET if table=='tcp' else socket.AF_INET6,raw))
    except IOError: pass
instances=[]
for name in os.listdir('/proc'):
    if not name.isdigit(): continue
    try: instance=identity(int(name))
    except (OSError,IOError,IndexError,ValueError): continue
    if instance: instances.append(instance[0])
if not listeners or identity(pid)!=original or os.readlink(at(rootfd,'current'))!=link or number('app.pid',4194304)!=pid or number('port.live',65535)!=port:
    sys.exit('service release, listener or process identity changed')
print(json.dumps(dict(directory=root,uid=uid,current=link,pid=pid,port=port,startTicks=original[1],started=when,
                      script=original[2],listener=True,listenAddresses=sorted(listeners),instances=sorted(instances)),sort_keys=True))
`;

export function compileServiceInspection(source: string) {
  const directory=inspectionRoot(source);
  if (!directory) return;
  const clean="/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/bin LC_ALL=C";
  const launch='cd / || exit 1; if test -x /usr/bin/python3; then py=/usr/bin/python3; else py=/usr/bin/python; fi; exec "$py" -EsSB -c "$1" "$2"';
  return {directory,profile:"service-inspection-v1" as const,command:clean+" /usr/sbin/runuser -u nobody -- "+clean+" /bin/sh -c "+quote(launch)+" lake-service-inspection "+quote(serviceProbe)+" "+quote(directory)};
}

export function reportedServiceIdentity(stdout:string) {
  const match=/^current=(releases\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,80})\npid=([1-9][0-9]{0,6})\nport=([1-9][0-9]{0,4})\nprocess:\n/.exec(stdout);
  if (!match || !stdout.endsWith("\nscoped processes:\n")) return;
  const [,current,pid,port]=match;
  const line=stdout.split("\n").find(row=>/^LISTEN\s/.test(row) && row.includes("pid="+pid+","));
  const address=line && /^LISTEN\s+\d+\s+\d+\s+(\d{1,3}(?:\.\d{1,3}){3}):([0-9]+)\s/.exec(line);
  if (!address || address[2]!==port || Number(port)>65535 || Number(pid)>4194304) return;
  return {current:current!,pid:Number(pid),port:Number(port),address:address[1]!};
}
