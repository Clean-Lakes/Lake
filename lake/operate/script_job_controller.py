"""Fixed remote control program. Inputs never select arbitrary filesystem paths."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time

os.umask(0o077)
TERMINAL = {'succeeded', 'failed', 'timed_out', 'cancelled', 'unknown'}

def private_dir(path, create=True):
    if create: path.mkdir(mode=0o700, exist_ok=True)
    s=path.lstat()
    if not stat.S_ISDIR(s.st_mode) or stat.S_IMODE(s.st_mode)!=0o700 or s.st_uid!=os.getuid():
        raise RuntimeError('job directory ownership or permissions invalid')

def read_json(path):
    s=path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o600:
        raise RuntimeError('job file ownership or permissions invalid')
    return json.loads(path.read_text())

def save(path,value):
    tmp=path.with_name(path.name+'.tmp')
    fd=os.open(str(tmp),os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(value,f);f.flush();os.fsync(f.fileno())
    os.replace(tmp,path)

def proc_identity(pid):
    try:
        fields=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
        return None if fields[0]=='Z' else fields[19]
    except (OSError,IndexError): return None

def status(directory):
    state=read_json(directory/'state.json')
    if state['status'] not in TERMINAL:
        if (not state.get('monitor_pid') and time.time()-state['started_at']>5) or (state.get('monitor_pid') and proc_identity(state['monitor_pid'])!=state.get('monitor_identity')):
            state.update(status='unknown',error='job monitor absent; do not replay execution')
    for name in ['stdout','stderr']:
        p=directory/(name+'.log')
        if p.exists():
            fd=os.open(str(p),os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(fd,'rb') as f:
                f.seek(max(0,os.fstat(f.fileno()).st_size-8192));state[name+'_tail']=f.read(8192).decode('utf-8',errors='replace')
    state['elapsed_seconds']=round(state.get('finished_at',time.time())-state['started_at'],2)
    return state

def capture(pipe,path):
    # Bound disk use even if a script writes continuously.
    try:
        with path.open('wb') as f:
            size=0
            while True:
                chunk=os.read(pipe.fileno(),4096)
                if not chunk: break
                if size+len(chunk)>131072:
                    f.flush()
                    with path.open('rb') as previous:
                        previous.seek(max(0,size-65536));tail=previous.read()
                    f.seek(0);f.truncate();f.write(tail);size=len(tail)
                f.write(chunk);f.flush();size+=len(chunk)
    finally: pipe.close()

def worker(directory):
    lock=os.open(str(directory/'worker.lock'),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    config=read_json(directory/'config.json')
    state=read_json(directory/'state.json')
    state.update(monitor_pid=os.getpid(),monitor_identity=proc_identity(os.getpid()),status='running')
    save(directory/'state.json',state)
    script=directory/'script'
    if hashlib.sha256(script.read_bytes()).hexdigest()!=config['script_sha256']:
        state.update(status='failed',error='script digest mismatch',finished_at=time.time());save(directory/'state.json',state);return
    child=subprocess.Popen([config['language'],str(script)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,cwd=str(directory),close_fds=True)
    pumps=[]
    for pipe,name in [(child.stdout,'stdout'),(child.stderr,'stderr')]:
        t=threading.Thread(target=capture,args=(pipe,directory/(name+'.log')),daemon=True);t.start();pumps.append(t)
    deadline=time.monotonic()+config['timeout_seconds']
    final=None
    while child.poll() is None:
        if (directory/'cancel.request').exists(): final='cancelled'
        elif time.monotonic()>=deadline: final='timed_out'
        if final:
            try: os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try: os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                child.wait(timeout=5)
            # A shell may exit on TERM while descendants ignore it.
            try: os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            break
        state['updated_at']=time.time();save(directory/'state.json',state);time.sleep(1)
    child.wait()
    for t in pumps: t.join(timeout=2)
    state.update(status=final or ('succeeded' if child.returncode==0 else 'failed'),exit_code=child.returncode,finished_at=time.time(),updated_at=time.time())
    save(directory/'state.json',state)

def control(request):
    job=request['job']
    if not re.fullmatch('[a-f0-9]{32}',job['id']): raise RuntimeError('invalid job id')
    base=Path.home()/'.lake-script-jobs';private_dir(base,request['action']=='start')
    directory=base/job['id']
    config={key:job[key] for key in ['id','script_id','script_sha256','target_sha256','language','timeout_seconds']}
    action=request['action']
    if action=='start':
        if config['language'] not in ['sh','bash'] or not 1<=config['timeout_seconds']<=86400: raise RuntimeError('invalid execution options')
        source=request['content'].encode('utf-8')
        if hashlib.sha256(source).hexdigest()!=config['script_sha256']: raise RuntimeError('script digest mismatch')
        try: directory.mkdir(mode=0o700)
        except FileExistsError:
            private_dir(directory)
            if read_json(directory/'config.json')!=config: raise RuntimeError('job identity mismatch')
            return status(directory) # Never launch an existing identity twice.
        save(directory/'config.json',config)
        (directory/'script').write_bytes(source)
        (directory/'controller.py').write_text(request['controller'])
        state={'id':job['id'],'status':'starting','started_at':time.time(),'updated_at':time.time()}
        save(directory/'state.json',state)
        monitor=subprocess.Popen([sys.executable,str(directory/'controller.py'),'--worker',str(directory)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True)
        # The worker alone owns state after launch; avoid a parent/worker race.
        for _ in range(40):
            value=read_json(directory/'state.json')
            if value.get('monitor_pid') or value['status'] in TERMINAL: return status(directory)
            time.sleep(.05)
        return {'id':job['id'],'status':'unknown','started_at':state['started_at'],'error':'monitor launch not confirmed; query this job, do not restart'}
    private_dir(directory,False)
    if read_json(directory/'config.json')!=config: raise RuntimeError('job identity mismatch')
    if action=='status': return status(directory)
    if action=='cancel':
        current=status(directory)
        if current['status'] not in TERMINAL: save(directory/'cancel.request',{'requested_at':time.time()})
        return current
    raise RuntimeError('unsupported job action')

if __name__=='__main__':
    if len(sys.argv)==3 and sys.argv[1]=='--worker':
        worker(Path(sys.argv[2]))
    else:
        try: print(json.dumps(control(json.load(sys.stdin))))
        except Exception as exc:
            print(json.dumps({'status':'unknown','error':type(exc).__name__+': '+str(exc)}));sys.exit(1)
