// In the jail as uid 65533: 127.0.0.1:3128 -> the supervisor's proxy.sock.
const net = require("node:net");
net.createServer((c) => {
  const u = net.connect("/run/peeps/sock/proxy.sock");
  c.pipe(u).pipe(c);
  u.on("error", () => c.destroy());
  c.on("error", () => u.destroy());
}).listen(3128, "127.0.0.1", () => console.log("ROW relay_listen pass"));
