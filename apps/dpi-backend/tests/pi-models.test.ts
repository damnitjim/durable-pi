// The Backend reuses pi's setup: API keys from auth.json (`!command` entries too), the default provider and model from
// settings.json, and custom endpoints from models.json. Everything reads a temporary agent folder, never the real ~/.pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { CredentialCommandError, loadPiModels } from "../src/pi-models.js";

async function agentDir(files: { settings?: object; auth?: object; models?: object }) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dpi-pi-")));
  if (files.settings) await writeFile(join(dir, "settings.json"), JSON.stringify(files.settings));
  if (files.auth) await writeFile(join(dir, "auth.json"), JSON.stringify(files.auth));
  if (files.models) await writeFile(join(dir, "models.json"), JSON.stringify(files.models));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const noEnv = {} as NodeJS.ProcessEnv;
const apiKeyOf = async (pi: Awaited<ReturnType<typeof loadPiModels>>, provider: string) =>
  (await pi.models.getAuth(provider))?.auth.apiKey;

test("API-key credentials come from pi's auth.json, and the default model from settings.json", async () => {
  const t = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" },
    auth: { openai: { type: "api_key", key: "sk-from-auth-json" } },
  });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    assert.equal(await apiKeyOf(pi, "openai"), "sk-from-auth-json");
    assert.deepEqual(pi.defaultModel, { provider: "openai", modelId: "gpt-5.6-luna" });
  } finally {
    await t.cleanup();
  }
});

test("a `!command` key is run for its value, once", async () => {
  const t = await agentDir({});
  try {
    const counter = join(t.dir, "runs");
    await writeFile(
      join(t.dir, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: `!echo x >> ${counter}; echo sk-from-command` } }),
    );
    await writeFile(join(t.dir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-5.6-luna" }));
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    assert.equal(await apiKeyOf(pi, "openai"), "sk-from-command");
    assert.equal(await apiKeyOf(pi, "openai"), "sk-from-command");
    assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 1, "the command output is cached");
  } finally {
    await t.cleanup();
  }
});

test("a failing `!command` leaves the key unresolved, with a message that names the provider", async () => {
  const t = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" },
    auth: { openai: { type: "api_key", key: "!exit 3" } },
  });
  try {
    await assert.rejects(() => loadPiModels({ agentDir: t.dir, env: noEnv }), /openai.*(key|credential)/i);
  } finally {
    await t.cleanup();
  }
});

test("a model whose key command fails is a CredentialCommandError, the Backend's own setup and not a bad request", async () => {
  const t = await agentDir({
    settings: { defaultProvider: "local-server", defaultModel: "Qwen3" },
    models: {
      providers: {
        "local-server": { baseUrl: "http://localhost:8080/v1", api: "openai-completions", apiKey: "literal", models: [{ id: "Qwen3" }] },
        "locked-vault": { baseUrl: "http://localhost:9090/v1", api: "openai-completions", apiKey: "!exit 3", models: [{ id: "M" }] },
      },
    },
  });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    await assert.rejects(() => pi.resolve("locked-vault/M"), (e: unknown) => e instanceof CredentialCommandError && /locked-vault/.test((e as Error).message));
    // Other refusals stay what they were: the caller asked for something that is not there.
    await assert.rejects(() => pi.resolve("local-server/NoSuch"), (e: unknown) => !(e instanceof CredentialCommandError) && /Unknown model/.test((e as Error).message));
  } finally {
    await t.cleanup();
  }
});

test("environment variables still work for a provider with nothing stored", async () => {
  const t = await agentDir({ settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" } });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: { OPENAI_API_KEY: "sk-from-env" } as NodeJS.ProcessEnv });
    assert.equal(await apiKeyOf(pi, "openai"), "sk-from-env");
  } finally {
    await t.cleanup();
  }
});

test("a job's `provider/model` overrides the default; no override means the default", async () => {
  const t = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" },
    auth: { openai: { type: "api_key", key: "k1" }, openrouter: { type: "api_key", key: "k2" } },
  });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    assert.deepEqual(await pi.resolve(undefined), { provider: "openai", modelId: "gpt-5.6-luna" });
    // Model ids can contain slashes (OpenRouter's): only the first one separates the provider.
    assert.deepEqual(await pi.resolve("openrouter/anthropic/claude-sonnet-5.5"), {
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5.5",
    });
    await assert.rejects(() => pi.resolve("openai/no-such-model"), /Unknown model openai\/no-such-model/);
    await assert.rejects(() => pi.resolve("nope/whatever"), /Unknown model nope\/whatever/);
    await assert.rejects(() => pi.resolve("just-a-name"), /provider\/model/);
  } finally {
    await t.cleanup();
  }
});

test("a provider with no credentials can't be overridden to", async () => {
  const t = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" },
    auth: { openai: { type: "api_key", key: "k1" } },
  });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    await assert.rejects(() => pi.resolve("groq/llama-3.3-70b-versatile"), /no API key/i);
  } finally {
    await t.cleanup();
  }
});

test("refuses to start when the default provider has only an OAuth login", async () => {
  const t = await agentDir({
    settings: { defaultProvider: "anthropic", defaultModel: "claude-sonnet-5-5" },
    auth: { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } },
  });
  try {
    await assert.rejects(
      () => loadPiModels({ agentDir: t.dir, env: noEnv }),
      (e: Error) => /anthropic/.test(e.message) && /OAuth/.test(e.message) && /add an API key/i.test(e.message),
    );
  } finally {
    await t.cleanup();
  }
});

test("refuses to start with a clear message when pi has no default model or no credentials for it", async () => {
  const none = await agentDir({});
  const keyless = await agentDir({ settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" } });
  const unknown = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "no-such-model" },
    auth: { openai: { type: "api_key", key: "k" } },
  });
  try {
    await assert.rejects(() => loadPiModels({ agentDir: none.dir, env: noEnv }), /defaultProvider.*defaultModel/);
    await assert.rejects(() => loadPiModels({ agentDir: keyless.dir, env: noEnv }), /no API key.*openai/i);
    await assert.rejects(() => loadPiModels({ agentDir: unknown.dir, env: noEnv }), /Unknown model openai\/no-such-model/);
  } finally {
    await Promise.all([none.cleanup(), keyless.cleanup(), unknown.cleanup()]);
  }
});

test("custom endpoints from models.json work as the default, with a literal, $ENV or `!command` key", async () => {
  const providers = (apiKey: string) => ({
    providers: {
      "local-server": {
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        apiKey,
        models: [{ id: "Qwen3", name: "Local Qwen", contextWindow: 262144, maxTokens: 32768 }],
      },
    },
  });
  const settings = { defaultProvider: "local-server", defaultModel: "Qwen3" };
  for (const [apiKey, env, expected] of [
    ["literal-key", noEnv, "literal-key"],
    ["$LOCAL_KEY", { LOCAL_KEY: "env-key" } as NodeJS.ProcessEnv, "env-key"],
    ["${LOCAL_KEY}", { LOCAL_KEY: "env-key" } as NodeJS.ProcessEnv, "env-key"],
    ["!echo cmd-key", noEnv, "cmd-key"],
  ] as const) {
    const t = await agentDir({ settings, models: providers(apiKey) });
    try {
      const pi = await loadPiModels({ agentDir: t.dir, env });
      assert.equal(await apiKeyOf(pi, "local-server"), expected, apiKey);
      assert.deepEqual(pi.defaultModel, { provider: "local-server", modelId: "Qwen3" });
      const model = pi.models.getModel("local-server", "Qwen3")!;
      assert.equal(model.contextWindow, 262144);
      assert.equal(model.baseUrl, "http://localhost:8080/v1");
    } finally {
      await t.cleanup();
    }
  }
});

test("an OAuth login is ignored when a key is available for the same provider, and refused only when it is all there is", async () => {
  const oauth = { type: "oauth", access: "a", refresh: "r", expires: 1 };
  const t = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" },
    auth: { openai: oauth },
  });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: { OPENAI_API_KEY: "sk-env" } as NodeJS.ProcessEnv });
    assert.equal(await apiKeyOf(pi, "openai"), "sk-env");
    await assert.rejects(() => loadPiModels({ agentDir: t.dir, env: noEnv }), /OAuth.*add an API key|Add an API key/is);
  } finally {
    await t.cleanup();
  }
});

/** A server that answers any chat completion with `reply`, and remembers the headers of the request. */
async function chatServer(reply: string) {
  const seen: { authorization?: string; custom?: string; url?: string; model?: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization, custom: req.headers["x-gateway"] as string | undefined, url: req.url, model: JSON.parse(body || "{}").model });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: reply }));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => server.close() };
}
const ask = (pi: Awaited<ReturnType<typeof loadPiModels>>, provider: string, id: string) =>
  pi.models.completeSimple(pi.models.getModel(provider, id)!, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });

test("a models.json entry named like a built-in provider changes that provider: a baseUrl moves its models, extra models are added", async () => {
  const plain = await agentDir({ settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" }, auth: { openai: { type: "api_key", key: "k" } } });
  const builtinCount = (await loadPiModels({ agentDir: plain.dir, env: noEnv })).models.getModels("openai").length;
  await plain.cleanup();
  const t = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" },
    auth: { openai: { type: "api_key", key: "sk-from-auth-json" } },
    models: {
      providers: {
        openai: {
          baseUrl: "http://gateway.test/v1",
          headers: { "x-gateway": "yes" },
          models: [{ id: "my-finetune", name: "My fine-tune", api: "openai-completions", contextWindow: 64000 }],
        },
      },
    },
  });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    const extra = pi.models.getModel("openai", "my-finetune")!;
    assert.equal(extra.name, "My fine-tune");
    assert.equal(extra.baseUrl, "http://gateway.test/v1");
    assert.equal(extra.contextWindow, 64000);
    // The built-in models are all still there, now sent through the gateway.
    const luna = pi.models.getModel("openai", "gpt-5.6-luna")!;
    assert.equal(luna.baseUrl, "http://gateway.test/v1");
    assert.deepEqual((luna as { headers?: object }).headers, { "x-gateway": "yes" });
    assert.equal(pi.models.getModels("openai").length, builtinCount + 1);
    // The credential is still pi's.
    assert.equal(await apiKeyOf(pi, "openai"), "sk-from-auth-json");
    assert.deepEqual(pi.defaultModel, { provider: "openai", modelId: "gpt-5.6-luna" });
    // And the Backend's own checks accept the new model.
    assert.deepEqual(await pi.resolve("openai/my-finetune"), { provider: "openai", modelId: "my-finetune" });
  } finally {
    await t.cleanup();
  }
});

test("a request for a model of a merged built-in provider goes to the overridden endpoint with pi's key and the extra headers", async () => {
  const server = await chatServer("hello from the gateway");
  const t = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "my-finetune" },
    auth: { openai: { type: "api_key", key: "sk-from-auth-json" } },
    models: { providers: { openai: { baseUrl: server.base, headers: { "x-gateway": "yes" }, models: [{ id: "my-finetune", api: "openai-completions" }] } } },
  });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    const answer = await ask(pi, "openai", "my-finetune");
    assert.match(JSON.stringify(answer.content), /hello from the gateway/);
    assert.equal(server.seen[0]?.authorization, "Bearer sk-from-auth-json");
    assert.equal(server.seen[0]?.custom, "yes");
    assert.equal(server.seen[0]?.model, "my-finetune");
  } finally {
    server.close();
    await t.cleanup();
  }
});

test("a models.json apiKey for a built-in provider is used only when auth.json has none", async () => {
  for (const [auth, expected] of [[undefined, "key-from-models-json"], [{ openai: { type: "api_key", key: "key-from-auth-json" } }, "key-from-auth-json"]] as const) {
    const t = await agentDir({
      settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" },
      ...(auth ? { auth } : {}),
      models: { providers: { openai: { apiKey: "$GATEWAY_KEY" } } },
    });
    try {
      const pi = await loadPiModels({ agentDir: t.dir, env: { GATEWAY_KEY: "key-from-models-json" } as NodeJS.ProcessEnv });
      assert.equal(await apiKeyOf(pi, "openai"), expected);
    } finally {
      await t.cleanup();
    }
  }
});

test("a merged entry that adds a model without an api, or uses one the Backend can't speak, is refused with the provider named", async () => {
  const base = { settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" }, auth: { openai: { type: "api_key", key: "k" } } };
  const noApi = await agentDir({ ...base, models: { providers: { openai: { baseUrl: "http://x/v1", models: [{ id: "m" }] } } } });
  const badApi = await agentDir({ ...base, models: { providers: { openai: { api: "carrier-pigeon", models: [{ id: "m" }] } } } });
  try {
    await assert.rejects(() => loadPiModels({ agentDir: noApi.dir, env: noEnv }), /provider "openai" model "m" needs an api/);
    await assert.rejects(() => loadPiModels({ agentDir: badApi.dir, env: noEnv }), /provider "openai" uses api "carrier-pigeon"/);
  } finally {
    await noApi.cleanup();
    await badApi.cleanup();
  }
});
test("enabledModels in pi's settings limits what the model list shows, with * as a wildcard, and never the default", async () => {
  const make = async (enabledModels?: unknown) => {
    const t = await agentDir({
      settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna", ...(enabledModels !== undefined ? { enabledModels } : {}) },
      auth: { openai: { type: "api_key", key: "k" } },
    });
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    await t.cleanup();
    return pi;
  };
  const ref = (provider: string, modelId: string) => ({ provider, modelId });

  const everything = await make();
  assert.equal(everything.isEnabled(ref("anthropic", "claude-x")), true, "no setting: every model");
  assert.equal((await make([])).isEnabled(ref("anthropic", "claude-x")), true, "an empty list is no setting");

  const some = await make(["anthropic/claude-*", "openai/gpt-5.6-luna", "local.box/m+1"]);
  assert.equal(some.isEnabled(ref("anthropic", "claude-sonnet")), true, "a wildcard");
  assert.equal(some.isEnabled(ref("anthropic", "other")), false);
  assert.equal(some.isEnabled(ref("openai", "gpt-4o")), false);
  assert.equal(some.isEnabled(ref("local.box", "m+1")), true, "regex characters in a pattern are literal");
  assert.equal(some.isEnabled(ref("localXbox", "m+1")), false);
  const onlyOthers = await make(["anthropic/*"]);
  assert.equal(onlyOthers.isEnabled(ref("openai", "gpt-5.6-luna")), true, "the default model is always listed");
  assert.equal((await make("not a list")).isEnabled(ref("anthropic", "claude-x")), true, "a malformed setting is ignored");
});

test("a credential in auth.json beats the apiKey in models.json", async () => {
  const t = await agentDir({
    settings: { defaultProvider: "local-server", defaultModel: "Qwen3" },
    auth: { "local-server": { type: "api_key", key: "from-auth-json" } },
    models: {
      providers: {
        "local-server": { baseUrl: "http://x/v1", api: "openai-completions", apiKey: "from-models-json", models: [{ id: "Qwen3" }] },
      },
    },
  });
  try {
    assert.equal(await apiKeyOf(await loadPiModels({ agentDir: t.dir, env: noEnv }), "local-server"), "from-auth-json");
  } finally {
    await t.cleanup();
  }
});

test("the Backend never writes pi's files", async () => {
  const t = await agentDir({
    settings: { defaultProvider: "openai", defaultModel: "gpt-5.6-luna" },
    auth: { openai: { type: "api_key", key: "k" } },
  });
  try {
    const before = await readFile(join(t.dir, "auth.json"), "utf8");
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    await pi.models.getAuth("openai");
    await pi.models.logout("openai");
    assert.equal(await readFile(join(t.dir, "auth.json"), "utf8"), before);
  } finally {
    await t.cleanup();
  }
});

test("a request to a models.json endpoint carries the resolved key", async () => {
  let authorization: string | undefined;
  const server = createServer((req, res) => {
    authorization = req.headers.authorization;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "Qwen3", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: "assistant", content: "hello from the local server" }));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const t = await agentDir({
    settings: { defaultProvider: "local-server", defaultModel: "Qwen3" },
    models: {
      providers: {
        "local-server": { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "!echo cmd-key", models: [{ id: "Qwen3" }] },
      },
    },
  });
  try {
    const pi = await loadPiModels({ agentDir: t.dir, env: noEnv });
    const answer = await pi.models.completeSimple(pi.models.getModel("local-server", "Qwen3")!, {
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    });
    assert.equal(authorization, "Bearer cmd-key");
    assert.match(JSON.stringify(answer.content), /hello from the local server/);
  } finally {
    server.close();
    await t.cleanup();
  }
});
