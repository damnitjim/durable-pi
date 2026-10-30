// The Backend reuses `pi`'s setup, so once you're logged in to pi, jobs work:
//
//   auth.json       API keys, including `!command` entries (run once, output cached, like pi). Never written to.
//   settings.json   `defaultProvider` / `defaultModel`: the model a job uses unless it names a `provider/model`.
//   models.json     custom endpoints (Ollama, llama.cpp, a proxy…), keyed with a literal, `$ENV` or `!command`.
//
// OAuth logins are refused: a refreshed token written by one process invalidates the other's copy, so sharing them
// would log pi or the Backend out. The Backend says so at startup instead.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ApiKeyCredential, Credential, CredentialStore, ProviderStreams } from "@earendil-works/pi-ai";

export type ModelRef = { provider: string; modelId: string };

export interface PiModels {
  models: MutableModels;
  /** pi's `defaultProvider` / `defaultModel`. */
  defaultModel: ModelRef;
  /** `provider/model` (split at the first slash) or a ref → a model the Backend can run; the default for none. */
  resolve(model?: string | ModelRef): Promise<ModelRef>;
  /**
   * Whether the model is one pi has enabled (`enabledModels` in settings.json: `provider/model` patterns where `*` matches
   * anything). With none set every model is; the default model always is. Only what the model list shows: any model
   * with a credential can still be asked for by name.
   */
  isEnabled(model: ModelRef): boolean;
}

export const defaultAgentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

// ------------------------------------------------------------------ values: literal, $ENV or !command

/** Runs shell commands for `!command` values and remembers their output for the life of the process. */
function commandRunner() {
  const cache = new Map<string, Promise<string>>();
  return (command: string): Promise<string> => {
    let result = cache.get(command);
    if (!result) {
      result = new Promise<string>((resolve, reject) => {
        execFile("/bin/sh", ["-c", command], { timeout: 10_000, encoding: "utf8" }, (error, stdout) => {
          const value = stdout.trim();
          if (error) reject(new Error(`\`${command}\` failed: ${error.message.split("\n")[0]}`));
          else if (!value) reject(new Error(`\`${command}\` printed nothing`));
          else resolve(value);
        });
      });
      // A failure isn't remembered: a locked keychain may be unlocked by the next try.
      result.catch(() => cache.delete(command));
      cache.set(command, result);
    }
    return result;
  };
}
type Run = ReturnType<typeof commandRunner>;

/**
 * A key could not be had: a `!command` in auth.json or models.json failed, or printed nothing (a locked keychain, a
 * missing tool). That is the Backend's own setup being broken, not a mistake in the request that asked for the model.
 */
export class CredentialCommandError extends Error {}

async function resolveValue(raw: string, env: NodeJS.ProcessEnv, run: Run): Promise<string | undefined> {
  if (raw.startsWith("!")) return run(raw.slice(1));
  const name = /^\$\{(\w+)\}$|^\$(\w+)$/.exec(raw);
  return name ? env[name[1] ?? name[2]] : raw;
}

const oauthRefusal = (provider: string) =>
  `pi is logged in to ${provider} with OAuth only, and the Backend can't share an OAuth login without logging one of you out. ` +
  `Add an API key for ${provider} (in pi's auth.json or the provider's environment variable), or pick another default model in pi.`;

// ------------------------------------------------------------------ pi's files

async function readJson<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/** A read-only view of pi's auth.json. Changes made through it (a refresh, a logout) stay in memory. */
class PiCredentialStore implements CredentialStore {
  #changes = new Map<string, Credential | null>();
  constructor(
    private stored: Record<string, Credential>,
    private run: Run,
  ) {}

  #current(id: string): Credential | undefined {
    return this.#changes.has(id) ? (this.#changes.get(id) ?? undefined) : this.stored[id];
  }
  async read(id: string) {
    const credential = this.#current(id);
    // Never handed to pi-ai: it would refresh the token, and the refresh invalidates pi's copy.
    if (credential?.type === "oauth") return undefined;
    if (credential?.type !== "api_key" || !credential.key?.startsWith("!")) return credential;
    try {
      return { ...credential, key: await this.run(credential.key.slice(1)) } satisfies ApiKeyCredential;
    } catch (e) {
      throw new Error(`could not get the API key for ${id} from auth.json: ${(e as Error).message}`);
    }
  }
  async list() {
    return Object.keys(this.stored)
      .filter((id) => this.#current(id)?.type === "api_key")
      .map((providerId) => ({ providerId, type: this.#current(providerId)!.type }));
  }
  async modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    const next = await fn(this.#current(id));
    if (next) this.#changes.set(id, next);
    return next ?? this.#current(id);
  }
  async delete(id: string) {
    this.#changes.set(id, null);
  }
}

type CustomProvider = {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: {
    id: string;
    name?: string;
    api?: string;
    reasoning?: boolean;
    input?: ("text" | "image")[];
    contextWindow?: number;
    maxTokens?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  }[];
};

const APIS = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
} as const;
type KnownApi = keyof typeof APIS;
const isKnownApi = (api: string | undefined): api is KnownApi => !!api && api in APIS;

/** The `models` of a models.json entry as pi-ai models, each with the api it needs. */
function customModels(id: string, config: CustomProvider, baseUrl: string) {
  const fail = (what: string) => new Error(`models.json: provider "${id}" ${what}`);
  return (config.models ?? []).map((m) => {
    const api = m.api ?? config.api;
    if (!isKnownApi(api)) throw fail(`model "${m.id}" needs an api`);
    return {
      id: m.id,
      name: m.name ?? m.id,
      api,
      provider: id,
      baseUrl,
      ...(config.headers ? { headers: config.headers } : {}),
      input: m.input ?? ["text"],
      reasoning: m.reasoning ?? false,
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...m.cost },
    };
  });
}

function customProvider(id: string, config: CustomProvider, env: NodeJS.ProcessEnv, run: Run) {
  const fail = (what: string) => new Error(`models.json: provider "${id}" ${what}`);
  if (!config.baseUrl) throw fail("needs a baseUrl");
  const baseUrl = config.baseUrl;
  if (config.api !== undefined && !isKnownApi(config.api))
    throw fail(`uses api "${config.api}", which the Backend doesn't support (${Object.keys(APIS).join(", ")})`);
  const models = customModels(id, config, baseUrl);
  const streams = Object.fromEntries(Object.entries(APIS).map(([api, make]) => [api, make()]));
  return createProvider({
    id,
    baseUrl,
    auth: {
      apiKey: {
        name: `${id} API key`,
        // auth.json first, then models.json's apiKey. No key at all is a keyless local server.
        resolve: async ({ credential }) => {
          const key = credential?.key ?? (config.apiKey ? await resolveValue(config.apiKey, env, run) : undefined);
          return { auth: key ? { apiKey: key } : {}, source: credential?.key ? "auth.json" : "models.json" };
        },
      },
    },
    models: models as never,
    api: streams as never,
  });
}

/**
 * A models.json entry named like a built-in provider changes that provider, as in pi: a `baseUrl` points all its models
 * somewhere else (a proxy, a gateway), `headers` are added to their requests, `models` are added (or replace the
 * built-in model of the same id), and an `apiKey` is used when auth.json has none. Everything else stays the built-in's.
 */
function mergedProvider(builtin: Provider, id: string, config: CustomProvider, env: NodeJS.ProcessEnv, run: Run): Provider {
  const fail = (what: string) => new Error(`models.json: provider "${id}" ${what}`);
  if (config.api !== undefined && !isKnownApi(config.api))
    throw fail(`uses api "${config.api}", which the Backend doesn't support (${Object.keys(APIS).join(", ")})`);
  const baseUrl = config.baseUrl ?? builtin.baseUrl ?? builtin.getModels()[0]?.baseUrl;
  if (config.models?.length && !baseUrl) throw fail("adds models and needs a baseUrl to send them to");
  const added = config.models?.length ? customModels(id, config, baseUrl!) : [];
  const addedIds = new Set(added.map((m) => m.id));
  type WithEndpoint = { baseUrl?: string; headers?: Record<string, string> };
  const redirect = <M extends WithEndpoint>(m: M): M => ({
    ...m,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.headers ? { headers: { ...m.headers, ...config.headers } } : {}),
  });
  const chat = (m: { type?: string }) => m.type === undefined || m.type === "chat";
  const apiKey = builtin.auth.apiKey;
  const auth =
    apiKey && config.apiKey
      ? {
          ...builtin.auth,
          apiKey: {
            ...apiKey,
            check: undefined, // the key from models.json counts as configured: let the resolution below say so
            resolve: async (input: Parameters<typeof apiKey.resolve>[0]) => {
              if (input.credential?.key) return apiKey.resolve(input);
              const key = await resolveValue(config.apiKey!, env, run);
              return key ? { auth: { apiKey: key }, source: "models.json" } : apiKey.resolve(input);
            },
          },
        }
      : builtin.auth;
  // A built-in provider streams all its chat models one way, whatever a model's `api` says; a model added here speaks the
  // api models.json gave it, so it is streamed by that implementation and everything else by the built-in's.
  const own = added.length ? (Object.fromEntries(Object.entries(APIS).map(([api, make]) => [api, make()])) as Record<string, ProviderStreams>) : {};
  const streamerOf = (model: { id: string; api: string }): ProviderStreams =>
    (addedIds.has(model.id) ? own[model.api] : undefined) ?? (builtin as unknown as ProviderStreams);
  return Object.create(builtin, {
    stream: { value: (model: never, ...rest: unknown[]) => (streamerOf(model) as { stream: (...a: unknown[]) => unknown }).stream(model, ...rest) },
    streamSimple: { value: (model: never, ...rest: unknown[]) => (streamerOf(model) as { streamSimple: (...a: unknown[]) => unknown }).streamSimple(model, ...rest) },
    baseUrl: { value: baseUrl },
    ...(config.headers ? { headers: { value: { ...builtin.headers, ...config.headers } } } : {}),
    auth: { value: auth },
    getModels: { value: () => [...builtin.getModels().filter((m) => !addedIds.has(m.id)).map(redirect), ...added] },
    ...(builtin.getAllModels
      ? {
          getAllModels: {
            value: () => [
              ...builtin.getAllModels!().filter((m) => !(chat(m) && addedIds.has(m.id))).map((m) => (chat(m) ? redirect(m as never) : m)),
              ...added,
            ],
          },
        }
      : {}),
  }) as Provider;
}

// ------------------------------------------------------------------ loading

export async function loadPiModels(
  options: { agentDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PiModels> {
  const dir = options.agentDir ?? defaultAgentDir();
  const env = options.env ?? process.env;
  const run = commandRunner();
  const settings = (await readJson<{ defaultProvider?: string; defaultModel?: string; enabledModels?: unknown }>(join(dir, "settings.json"))) ?? {};
  const stored = (await readJson<Record<string, Credential>>(join(dir, "auth.json"))) ?? {};
  const custom = (await readJson<{ providers?: Record<string, CustomProvider> }>(join(dir, "models.json")))?.providers ?? {};

  const models = builtinModels({
    credentials: new PiCredentialStore(stored, run),
    authContext: {
      env: async (name) => env[name],
      fileExists: async (path) => existsSync(path.replace(/^~(?=\/|$)/, homedir())),
    },
  });
  for (const [id, config] of Object.entries(custom)) {
    const builtin = models.getProvider(id);
    models.setProvider(builtin ? mergedProvider(builtin, id, config, env, run) : customProvider(id, config, env, run));
  }

  const known = async (ref: ModelRef) => {
    if (!models.getModel(ref.provider, ref.modelId)) throw new Error(`Unknown model ${ref.provider}/${ref.modelId}`);
    let auth;
    try {
      auth = await models.getAuth(ref.provider);
    } catch (e) {
      throw new CredentialCommandError(`Could not get an API key for ${ref.provider}: ${(e as Error).message}`);
    }
    if (!auth && stored[ref.provider]?.type === "oauth") throw new Error(oauthRefusal(ref.provider));
    if (!auth) throw new Error(`There is no API key for ${ref.provider}: add one in pi's auth.json or set its environment variable.`);
    return ref;
  };

  const resolve = async (model?: string | ModelRef): Promise<ModelRef> => {
    if (model === undefined) return defaultModel;
    if (typeof model !== "string") return known(model);
    const slash = model.indexOf("/");
    if (slash < 1 || slash === model.length - 1) throw new Error(`Model "${model}" must be provider/model`);
    return known({ provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
  };

  if (!settings.defaultProvider || !settings.defaultModel)
    throw new Error(`pi has no default model: set defaultProvider and defaultModel in ${join(dir, "settings.json")} (pi's /model, then Ctrl+S).`);
  const defaultModel: ModelRef = { provider: settings.defaultProvider, modelId: settings.defaultModel };
  await known(defaultModel);
  const patterns = (Array.isArray(settings.enabledModels) ? settings.enabledModels : [])
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => new RegExp(`^${p.trim().split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`));
  const isEnabled = (model: ModelRef) =>
    patterns.length === 0 || (model.provider === defaultModel.provider && model.modelId === defaultModel.modelId) || patterns.some((re) => re.test(`${model.provider}/${model.modelId}`));
  return { models, defaultModel, resolve, isEnabled };
}
