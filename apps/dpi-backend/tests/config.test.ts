// The device configuration: what the environment turns into, and what it warns or refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const base = { DPI_TOKEN: "t".repeat(40), DPI_HOME: "/nonexistent/dpi-home", DPI_ENV_FILE: "/nonexistent/none.env" } as NodeJS.ProcessEnv;

/** Run `body` and return what it wrote to stderr through console.error. */
function warnings(body: () => void): string[] {
  const saved = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    body();
  } finally {
    console.error = saved;
  }
  return lines;
}

test("the provider is pi unless it is faux, and a stale DPI_PROVIDER (openrouter, …) is said to mean pi", () => {
  assert.equal(loadConfig([], base).provider, "pi");
  assert.equal(loadConfig([], { ...base, DPI_PROVIDER: "faux" }).provider, "faux");
  assert.deepEqual(warnings(() => void loadConfig([], { ...base, DPI_PROVIDER: "pi" })), [], "pi and faux are not warned about");
  assert.deepEqual(warnings(() => void loadConfig([], { ...base, DPI_PROVIDER: "faux" })), []);
  const stale = warnings(() => assert.equal(loadConfig([], { ...base, DPI_PROVIDER: "openrouter" }).provider, "pi"));
  assert.equal(stale.length, 1);
  assert.match(stale[0]!, /DPI_PROVIDER=openrouter.*pi's setup/);
});

test("DPI_RESTART_LIMIT is optional, a whole number of 1 or more, and passed on as a number", () => {
  assert.equal(loadConfig([], base).restartLimit, undefined, "unset: pi-durable's own default");
  assert.equal(loadConfig([], { ...base, DPI_RESTART_LIMIT: "3" }).restartLimit, 3);
  for (const bad of ["0", "-1", "2.5", "many"])
    assert.throws(() => loadConfig([], { ...base, DPI_RESTART_LIMIT: bad }), /DPI_RESTART_LIMIT must be a whole number/, bad);
});

test("a token shorter than 32 characters, or a bad port, is refused", () => {
  assert.throws(() => loadConfig([], { ...base, DPI_TOKEN: "short" }), /DPI_TOKEN/);
  assert.throws(() => loadConfig([], { ...base, DPI_PORT: "99999" }), /Invalid port/);
});
