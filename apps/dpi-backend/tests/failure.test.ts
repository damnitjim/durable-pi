import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireEntry } from "../../dpi-sdk/src/api.js";
import { lastFailure } from "../../dpi-sdk/src/transcript.js";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (id: number): WireEntry => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "go" }] });
const assistant = (id: number, content: unknown[], stopReason: string, errorMessage?: string): WireEntry => ({
  id,
  conversationId: 1,
  kind: "pi.assistant",
  model: [{ role: "assistant", content, provider: "p", model: "m", usage, stopReason, ...(errorMessage ? { errorMessage } : {}) }] as WireEntry["model"],
});
const call = (name: string, args: unknown) => ({ type: "toolCall", id: name, name, arguments: args });

test("lastFailure reports the error and the failing turn's last tool call", () => {
  const entries = [user(1), assistant(2, [call("bash", { command: "ls" })], "toolUse"), assistant(3, [], "error", "429 rate limited")];
  assert.deepEqual(lastFailure(entries), { error: "429 rate limited", lastAction: 'bash {"command":"ls"}' });
});

test("lastFailure ignores tool calls from earlier turns and falls back to a generic message", () => {
  const entries = [user(1), assistant(2, [call("bash", {})], "toolUse"), assistant(3, [], "stop"), user(4), assistant(5, [], "error")];
  assert.deepEqual(lastFailure(entries), { error: "The agent ended with an error" });
});

test("lastFailure is undefined when the last turn succeeded, even after an earlier error", () => {
  assert.equal(lastFailure([user(1), assistant(2, [], "error", "boom"), user(3), assistant(4, [], "stop")]), undefined);
  assert.equal(lastFailure([]), undefined);
});
