"""A bounded JSON bridge to a real PTY; used only by CLI regression tests."""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
pending = b''
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [], 0.1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            print(json.dumps({'output': base64.b64encode(data).decode()}), flush=True)
        if sys.stdin.buffer in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                command = json.loads(line)
                if 'write' in command:
                    os.write(master, command['write'].encode())
                if 'resize' in command:
                    rows, cols = command['resize']
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                    os.kill(pid, signal.SIGWINCH)
                if 'signal' in command:
                    os.kill(pid, getattr(signal, command['signal']))
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)
    print(json.dumps({'exit': os.waitstatus_to_exitcode(status)}), flush=True)
finally:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(master)
