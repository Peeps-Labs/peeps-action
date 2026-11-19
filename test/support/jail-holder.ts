/**
 * A supervisor stand-in for load-jail.test.ts's teardown cases: it starts a jail
 * from the spec in argv, prints `READY <unit>`, lets the executor start, and
 * waits to be killed.
 */
import net from "node:net";
import { startJail } from "../../src/load/jail";
import type { JailSpec } from "../../src/load/jail/spec";

async function main(): Promise<void> {
  const spec = JSON.parse(process.argv[2]!) as JailSpec;
  const handle = await startJail(spec, {
    listenProxy: (path) =>
      new Promise((resolve) => {
        const server = net.createServer((c) => c.destroy());
        server.listen(path, () => resolve(server));
      }),
  });
  await handle.ready;
  handle.start();
  process.stdout.write(`READY ${handle.unit}\n`);
  setInterval(() => undefined, 60_000);
}

void main();
