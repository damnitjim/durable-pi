// pi's setup, end to end through the Backend: sessions default to pi's model, a job-style `provider/model` override
// works, and the process refuses to start on an OAuth-only default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/store.js";
import { loadPiModels } from "../src/pi-models.js";
import { freePort } from "./helpers.js";

async function piFolder(files: Record<string, object>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-pib-")));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  for (const [name, content] of Object.entries(files)) await writeFile(join(agentDir, name), JSON.stringify(content));
  await mkdir(join(root, "work"));
  return { root, agentDir, work: join(root, "work"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

const localServer = {
  "settings.json": { defaultProvider: "local-server", defaultModel: "Qwen3" },
  "models.json": {
    providers: {
      "local-server": {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "k",
        models: [{ id: "Qwen3", contextWindow: 262144 }, { id: "Other", contextWindow: 8192 }],
      },
    },
  },
};

test("a session uses pi's default model unless it names another, and unknown models are rejected", async () => {
  const t = await piFolder(localServer);
  const pi = await loadPiModels({ agentDir: t.agentDir, env: {} as NodeJS.ProcessEnv });
  const store = await Store.open({ dataDir: join(t.root, "data"), startDirs: [t.work], name: "t", provider: "pi", pi });
  try {
    assert.ok(store.modelList.some((m) => m.provider === "local-server" && m.id === "Qwen3"));

    const byDefault = await store.create({ name: "Default", cwd: t.work });
    const other = await store.create({ name: "Other", cwd: t.work, model: { provider: "local-server", modelId: "Other" } });
    const modelOf = async (id: string) => (await store.resolveAgent(id, "main")).row;
    assert.deepEqual(
      [await modelOf(byDefault.id), await modelOf(other.id)].map((r) => [r.provider, r.model]),
      [["local-server", "Qwen3"], ["local-server", "Other"]],
    );
    await assert.rejects(
      () => store.create({ name: "Bad", cwd: t.work, model: { provider: "local-server", modelId: "Nope" } }),
      /Unknown model local-server\/Nope/,
    );
    assert.equal(store.routedModel({ provider: "gone", modelId: "x" }).modelId, "Qwen3", "a vanished model falls back to the default");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("the Backend process refuses to start on an OAuth-only default, saying what to do", async () => {
  const t = await piFolder({
    "settings.json": { defaultProvider: "anthropic", defaultModel: "claude-fable-5" },
    "auth.json": { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } },
  });
  try {
    const child = spawn(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "../src/main.ts"), "--port", String(await freePort())], {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: t.agentDir,
        DPI_HOME: join(t.root, "home"),
        DPI_ENV_FILE: join(t.root, "none.env"),
        DPI_TOKEN: "x".repeat(40),
        DPI_PROVIDER: "pi",
      },
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const [code] = (await once(child, "exit")) as [number];
    assert.equal(code, 1);
    assert.match(stderr, /cannot start/);
    assert.match(stderr, /anthropic.*OAuth/);
    assert.match(stderr, /Add an API key/);
  } finally {
    await t.cleanup();
  }
});
