import next from "next";
import { createServer } from "node:http";
import { once } from "node:events";

const app = next({ dev: true, dir: process.argv[2], quiet: true, webpack: true });
await app.prepare();
const server = createServer((request, response) => {
  void app.getRequestHandler()(request, response);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Fixture server did not bind a TCP port.");
const origin = `http://127.0.0.1:${address.port}`;
await fetch(origin);
await fetch(`${origin}/projects/42`, { headers: { cookie: "atlas-member=yes" } });
await fetch(`${origin}/problem`);
process.send?.({ type: "ready", origin });
console.log(JSON.stringify({ type: "ready", origin, pid: process.pid }));
process.on("message", async (message) => {
  if (message?.type !== "stop") return;
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
  await app.close();
  process.exit(0);
});
