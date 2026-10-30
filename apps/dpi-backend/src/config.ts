// Device configuration: ~/.dpi/backend.env (or $DPI_ENV_FILE) plus CLI flags.
// Nothing here knows about specific machines; dpi-network.yaml on the operator's laptop
// writes this env file through `just net up <device>`.
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

export interface BackendConfig {
  name: string;
  host: string;
  port: number;
  home: string;
  envFile: string;
  dataDir: string;
  startDirs: string[];
  provider: "pi" | "faux";
  token: string;
  /** How many crashes in a row park a task instead of running it again; pi-durable's own default (5) when unset. */
  restartLimit?: number;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadConfig(argv = process.argv.slice(2), env = process.env): BackendConfig {
  const flag = (key: string, fallback: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return fallback;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw Error(`${key} needs a value`);
    return value;
  };
  const home = expand(env.DPI_HOME ?? join(homedir(), ".dpi"));
  const envFile = expand(flag("--env-file", env.DPI_ENV_FILE ?? join(home, "backend.env")));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config: BackendConfig = {
    name: flag("--name", env.DPI_DEVICE_NAME ?? hostname().replace(/\.local$/, "")),
    host: flag("--host", env.DPI_HOST ?? "127.0.0.1"),
    port: Number(flag("--port", env.DPI_PORT ?? "4780")),
    home,
    envFile,
    dataDir: resolve(expand(flag("--data-dir", env.DPI_DATA_DIR ?? join(home, "backend")))),
    startDirs: flag("--start-dirs", env.DPI_START_DIRS ?? "~/dpi-work")
      .split(":")
      .filter(Boolean)
      .map((p) => resolve(expand(p))),
    provider: env.DPI_PROVIDER === "faux" ? "faux" : "pi",
    token: env.DPI_TOKEN ?? "",
    ...(env.DPI_RESTART_LIMIT ? { restartLimit: Number(env.DPI_RESTART_LIMIT) } : {}),
  };
  if (env.DPI_PROVIDER && env.DPI_PROVIDER !== "faux" && env.DPI_PROVIDER !== "pi")
    console.error(`[config] DPI_PROVIDER=${env.DPI_PROVIDER} is not a provider any more: the Backend uses pi's setup (pi's keys and default model). Set it to "pi" or "faux", or remove it.`);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw Error(`Invalid port: ${config.port}`);
  if (config.restartLimit !== undefined && !(Number.isInteger(config.restartLimit) && config.restartLimit >= 1))
    throw Error(`DPI_RESTART_LIMIT must be a whole number of 1 or more, got ${env.DPI_RESTART_LIMIT}`);
  if (config.token.length < 32)
    throw Error(
      `DPI_TOKEN is missing or shorter than 32 characters (looked in ${envFile}). Create one with: npm run token`,
    );
  return config;
}
