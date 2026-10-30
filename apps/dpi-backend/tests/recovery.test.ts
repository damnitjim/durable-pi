import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("SIGKILL restart resumes a durable job from its checkpoint with no client attached", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Crash recovery", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "change-watch", input: { checks: 4, interval_seconds: 2 } });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => ((await run())?.phases[1].progress?.done ?? 0) >= 1, 15000, "first check");
    await server.stop("SIGKILL");
    await server.start();
    await until(async () => (await run())?.status === "completed", 30000, "completion after SIGKILL");
    const done = await run();
    assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done"]);
    assert.equal(done.phases[1].steps.filter((s) => s.kind === "checkpoint" && s.status === "done").length, 4);
    const history = await main.entries({ scope: "all" });
    assert.equal(history.items.filter((e) => e.kind === "demo.job").length, 1);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("a task the crash-loop guard parks leaves its agent busy forever with no agent.finished; /inspect says why, and an abort clears it (#51)", async () => {
  const t = await tempStore();
  const token = newToken();
  // A limit of 1: a task cut off by a single crash is parked at the next open, instead of the default five.
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token, env: { DPI_RESTART_LIMIT: "1" } });
  const get = (path: string) => fetch(`${server.base}/v1${path}`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<any>);
  const parkedTasks = async (id: string) =>
    ((await get(`/sessions/${id}/inspect`)).tasks as any[]).filter((task) => task.state?.kind === "blocked" && task.state?.reason === "restart_limit");
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Parked", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    // A long bash call: its tool task is running when the process dies.
    await main.send("!sleep 300");
    await until(async () => ((await get(`/sessions/${s.id}/tasks?status=live`)) as any[]).some((task) => task.label === "bash"), 20000, "the bash call to be running");
    await server.stop("SIGKILL");
    await server.start();

    // A subscriber to the device stream from here on hears of this session's agent only if it finishes.
    const heard: string[] = [];
    const stream = new AbortController();
    void (async () => {
      const response = await fetch(`${server.base}/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal: stream.signal });
      const decoder = new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) heard.push(decoder.decode(chunk));
    })().catch(() => {}); // ends when the test aborts it

    await until(async () => (await parkedTasks(s.id)).length > 0, 30000, "a task parked by the restart limit");
    await new Promise((r) => setTimeout(r, 1500));
    // The parked task is named, and with the reason the Scheduler looks for.
    assert.deepEqual((await parkedTasks(s.id)).map((p) => p.state), [{ kind: "blocked", reason: "restart_limit" }]);
    // To a poller the agent is busy for good: not idle, so an "idle" check never sees the end.
    assert.equal((await get(`/sessions/${s.id}`)).agents[0].busy, true);
    // The transcript never gets an answer: its newest item is the turn's pending tool call.
    const last = (await get(`/sessions/${s.id}/agents/main/transcript?format=json`)).items.at(-1);
    assert.equal(last.kind, "assistant");
    assert.deepEqual(last.blocks.filter((b: any) => b.type === "tool").map((b: any) => b.call.status), ["pending"]);
    // To a stream subscriber it never ends: no agent.finished for the session while it is parked.
    assert.equal(heard.join("").includes('"agent.finished"'), false, "no agent.finished");

    // Aborting the session settles the parked task: the agent goes idle and nothing is left blocked.
    const abort = await fetch(`${server.base}/v1/sessions/${s.id}/agents/main/abort`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ background: true }) });
    assert.equal(abort.status, 200);
    await until(async () => (await get(`/sessions/${s.id}`)).agents[0].busy === false, 10000, "the agent to go idle after the abort");
    assert.deepEqual(await parkedTasks(s.id), []);
    stream.abort();
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
