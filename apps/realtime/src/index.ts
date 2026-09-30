import { createServer } from "node:http";
import { PROTOCOL_VERSION } from "@quizmaster/shared";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.REALTIME_PORT ?? 4000);

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end();
});

server.listen(port, host, () => {
  console.info(`realtime listening on ${host}:${port} (protocol ${PROTOCOL_VERSION})`);
});
