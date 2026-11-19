// Supervisor side (runner user): proxy.sock -> the sink. Stands in for the gate.
const net = require("node:net");
const [sock, host, port] = process.argv.slice(2);
net.createServer((c) => {
  const u = net.connect(Number(port), host);
  c.pipe(u).pipe(c);
  u.on("error", () => c.destroy());
  c.on("error", () => u.destroy());
}).listen(sock, () => console.log("fwd listening", sock));
