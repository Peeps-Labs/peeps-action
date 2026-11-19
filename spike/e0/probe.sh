#!/bin/bash
# Runs in the jail as the executor (uid 65534, no caps). Every escape should fail.
row() { echo "ROW $1 $2"; }
row exec_id "$(id -u):$(id -g)"
cat /run/peeps/ws/package.json > /dev/null 2>&1 && row read_ws pass || row read_ws FAIL
touch /run/peeps/ws/e0-write-probe 2>/dev/null && row write_ws_root allowed || row write_ws_root denied
r=$(curl -sS -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3128/via-relay" 2>&1); [ "$r" = 200 ] && row relay_positive pass || row relay_positive "FAIL [$r]"
curl -s -m 3 "http://$SINK_ADDR/direct-tcp" > /dev/null && row direct_tcp FAIL || row direct_tcp pass
getent hosts example.com > /dev/null && row dns FAIL || row dns pass
python3 - "$SINK_ADDR" <<'PY'
import socket, sys, ctypes, os, errno
host, port = sys.argv[1].split(":"); port = int(port)
def row(k, v): print(f"ROW {k} {v}")
def tryit(k, fn):
    try: fn(); row(k, "FAIL-allowed")
    except OSError as e: row(k, f"pass-{errno.errorcode.get(e.errno, e.errno)}")
tryit("af_vsock", lambda: socket.socket(40, socket.SOCK_STREAM))
tryit("af_packet", lambda: socket.socket(17, socket.SOCK_RAW, 0))
tryit("raw_inet", lambda: socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP))
tryit("raw_inet6", lambda: socket.socket(socket.AF_INET6, socket.SOCK_RAW, socket.IPPROTO_ICMPV6))
tryit("udp_send", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"udp-escape", (host, port + 1)))
def unix_proxy():
    s = socket.socket(socket.AF_UNIX); s.connect("/run/peeps/sock/proxy.sock")
tryit("unix_proxy_sock_as_executor", unix_proxy)
libc = ctypes.CDLL(None, use_errno=True)
r = libc.syscall(425, 8, ctypes.c_void_p(0))  # io_uring_setup
row("io_uring_setup", f"ret={r}-{errno.errorcode.get(ctypes.get_errno(), ctypes.get_errno())}")
r = libc.syscall(321, 0, 0, 0)  # bpf
row("bpf", f"ret={r}-{errno.errorcode.get(ctypes.get_errno(), ctypes.get_errno())}")
PY
socks=$(find / -path /proc -prune -o -type s -print 2>/dev/null | tr '\n' ' ')
row unix_sockets_visible "[${socks}]"
ls /proc/1/root > /dev/null 2>&1 && row proc1_root FAIL-readable || row proc1_root pass
cat /proc/1/environ > /dev/null 2>&1 && row proc1_environ FAIL-readable || row proc1_environ pass
sudo -n true > /dev/null 2>&1 && row sudo FAIL-works || row sudo pass
unshare -U -r true > /dev/null 2>&1 && row nested_userns allowed || row nested_userns denied
row interfaces "$(ip -o link 2>/dev/null | awk -F': ' '{print $2}' | tr '\n' ',')"
row mounts_count "$(wc -l < /proc/self/mountinfo)"
ls /home /mnt /var 2>/dev/null | head -3 > /dev/null; row host_home_visible "$([ -d /home/runner ] && echo FAIL-yes || echo pass-no)"
