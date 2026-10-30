// dpi-backend: one device of the Durable Agent Network.
import express from "express";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { loadPiModels } from "./pi-models.js";
import { bearerAuth } from "./auth.js";
import { errorMiddleware } from "./errors.js";
import { v1 } from "./routes.js";

const config = loadConfig();
const exitWith = (error: unknown): never => {
  console.error(`dpi-backend cannot start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
};
// pi's credentials and default model; throws a plain message (OAuth-only login, no default model…) rather than starting.
const pi = config.provider === "pi" ? await loadPiModels().catch(exitWith) : undefined;
const store = await Store.open({
  dataDir: config.dataDir,
  startDirs: config.startDirs,
  name: config.name,
  provider: config.provider,
  pi,
  ...(config.restartLimit !== undefined ? { restartLimit: config.restartLimit } : {}),
});

const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.use("/v1", bearerAuth(config.token), express.json({ limit: "256kb" }), v1(store));
app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "Route not found" } }));
app.use(errorMiddleware);

const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  console.log(`dpi-backend "${config.name}" (uid ${store.uid}) on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}  start dirs: ${config.startDirs.join(", ")}  provider: ${config.provider}`);
  if (config.host === "0.0.0.0")
    for (const addresses of Object.values(networkInterfaces()))
      for (const a of addresses ?? [])
        if (a.family === "IPv4" && !a.internal) console.log(`LAN: http://${a.address}:${config.port}`);
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await store.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
