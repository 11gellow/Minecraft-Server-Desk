"""Bridge a private WebSocket to an actual Linux pseudo-terminal."""
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

child, master = pty.fork()
if child == 0:
    shell = os.environ.get("SHELL", "/bin/bash")
    os.environ["TERM"] = "xterm-256color"
    os.execv(shell, [shell, "-il"])
pending = b""
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [])
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.buffer in ready:
            # Read an OS chunk so select and Python's buffering cannot disagree.
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            lines = pending.split(b"\n")
            pending = lines.pop()
            for line in lines:
                event = json.loads(line)
                if event["type"] == "input":
                    payload = base64.b64decode(event["data"])
                    while payload:
                        payload = payload[os.write(master, payload):]
                if event["type"] == "resize":
                    size = struct.pack("HHHH", event["rows"], event["cols"], 0, 0)
                    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
finally:
    os.close(master)
    try:
        os.killpg(child, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.waitpid(child, 0)
