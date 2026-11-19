# Records every TCP request line and UDP datagram it receives.
import socket, sys, threading, time
port = int(sys.argv[1]); log = open(sys.argv[2], "a", buffering=1)
def udp():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("0.0.0.0", port + 1))
    while True:
        d, a = s.recvfrom(2048); log.write(f"{time.time():.3f} UDP {d[:60]!r}\n")
threading.Thread(target=udp, daemon=True).start()
t = socket.socket(); t.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); t.bind(("0.0.0.0", port)); t.listen(64)
while True:
    c, a = t.accept()
    try:
        c.settimeout(2); line = c.recv(1024).split(b"\r\n")[0]
        log.write(f"{time.time():.3f} TCP {line.decode(errors='replace')}\n")
        c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n")
    except Exception as e:
        log.write(f"{time.time():.3f} ERR {e}\n")
    finally:
        c.close()
