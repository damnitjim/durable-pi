// Which key Jev is asked with: TypeSafe's own if set, else pi's OpenRouter credential, else OPENROUTER_API_KEY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { askJev, type JevQuestion } from "../src/jev.js";

const questions: Record<string, JevQuestion> = { risky: { type: "noul", instructions: "Is it risky?" } };

/** Run `body` with fetch replaced by one that records the call and answers, and the key variables as given. */
async function withJev(env: { TYPESAFE_API_KEY?: string; OPENROUTER_API_KEY?: string }, body: (calls: { url: string; authorization: string }[]) => Promise<void>) {
  const saved = { fetch: globalThis.fetch, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
  const calls: { url: string; authorization: string }[] = [];
  for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] as const) {
    if (env[name] === undefined) delete process.env[name];
    else process.env[name] = env[name];
  }
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), authorization: String((init.headers as Record<string, string>).Authorization) });
    return new Response(JSON.stringify({ answers: { risky: { type: "noul", noul: 0.1 } } }), { status: 200 });
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"] as const) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test("Jev is asked with pi's OpenRouter credential, through OpenRouter", async () => {
  await withJev({}, async (calls) => {
    await askJev({ command: "ls" }, questions, undefined, async () => "sk-from-pi");
    assert.deepEqual(calls, [{ url: "https://openrouter.ai/api/alpha/decisions", authorization: "Bearer sk-from-pi" }]);
  });
});

test("pi's credential wins over the OPENROUTER_API_KEY variable, and TYPESAFE_API_KEY goes to TypeSafe directly", async () => {
  await withJev({ OPENROUTER_API_KEY: "sk-from-env" }, async (calls) => {
    await askJev({ command: "ls" }, questions, undefined, async () => "sk-from-pi");
    assert.equal(calls[0]!.authorization, "Bearer sk-from-pi");
  });
  await withJev({ TYPESAFE_API_KEY: "ts-key", OPENROUTER_API_KEY: "sk-from-env" }, async (calls) => {
    await askJev({ command: "ls" }, questions, undefined, async () => "sk-from-pi");
    assert.deepEqual(calls, [{ url: "https://api.typesafe.ai/v1/systemone", authorization: "Bearer ts-key" }]);
  });
});

test("without a pi credential the OPENROUTER_API_KEY variable still works, and with neither Jev says what it needs", async () => {
  await withJev({ OPENROUTER_API_KEY: "sk-from-env" }, async (calls) => {
    await askJev({ command: "ls" }, questions, undefined, async () => undefined);
    assert.equal(calls[0]!.authorization, "Bearer sk-from-env");
    await askJev({ command: "ls" }, questions); // no pi at all (the offline Backend)
    assert.equal(calls[1]!.authorization, "Bearer sk-from-env");
  });
  await withJev({}, async (calls) => {
    await assert.rejects(() => askJev({ command: "ls" }, questions, undefined, async () => undefined), /auth\.json.*OPENROUTER_API_KEY/);
    await assert.rejects(() => askJev({ command: "ls" }, questions, undefined, async () => { throw new Error("locked"); }), /auth\.json/);
    assert.deepEqual(calls, []);
  });
});
