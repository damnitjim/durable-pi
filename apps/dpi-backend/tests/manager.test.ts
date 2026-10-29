// The Manager's job tools, in a real backend with the faux model, against a stub Scheduler API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";
import type { Attention } from "../src/ask-user.js";
import { CONFIRM_TIMEOUT_S, MANAGER_PROMPT } from "../src/manager.js";

type Seen = { method: string; path: string; body: any; auth: string | undefined };

/** A stand-in for the Scheduler's localhost API: records what it is asked, serves a few jobs and questions. */
async function stubScheduler() {
  const seen: Seen[] = [];
  const jobs: any[] = [
    { id: "j1", name: "Daily Digest", prompt: "Summarise", schedule: { kind: "cron", expr: "0 7 * * *", timezone: "America/Chicago" }, status: "active", nextFireAt: Date.parse("2026-10-30T12:00:00Z"), sessionPolicy: "fresh", model: null, workspace: null, notifyMode: "always", trusted: false, catchUpWindowMs: 7_200_000 },
  ];
  const questions = [
    { id: "s9/q1", questionId: "q1", jobId: "j1", question: "Deploy it?", choices: ["Approve", "Deny"], askedAt: 1, timeoutAt: 2 },
    { id: "s9/q10", questionId: "q10", jobId: "j1", question: "Delete the branch?", choices: ["Yes", "No"], askedAt: 1, timeoutAt: 2 },
  ];
  let refuse: string | undefined;
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://stub");
    const record: Seen = { method: req.method ?? "", path: url.pathname + url.search, body: raw ? JSON.parse(raw) : undefined, auth: req.headers.authorization };
    seen.push(record);
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (refuse) return send(409, { error: refuse });
    const preview = (job: any) => ({ ...job, nextFireTimes: ["2026-10-29T22:00:00.000Z"] });
    if (req.method === "GET" && url.pathname === "/jobs") return send(200, jobs);
    if (req.method === "POST" && url.pathname === "/jobs") {
      const job = { id: "j2", status: "active", nextFireAt: 1, sessionPolicy: "fresh", model: null, workspace: null, notifyMode: "always", trusted: false, catchUpWindowMs: 7_200_000, ...record.body, schedule: record.body.schedule };
      if (url.searchParams.get("dryRun") !== "true") jobs.push(job);
      return send(url.searchParams.get("dryRun") === "true" ? 200 : 201, preview(job));
    }
    const one = /^\/jobs\/([^/]+)(\/(run|stop|reset))?$/.exec(url.pathname);
    if (one) {
      const job = jobs.find((j) => j.id === one[1]);
      if (!job) return send(404, { error: "no such job" });
      if (req.method === "PATCH") return send(200, preview({ ...job, ...record.body }));
      if (req.method === "DELETE") return send(204, {});
      if (one[3] === "run") return send(200, { id: `${job.id}:1`, status: "running" });
      if (one[3] === "stop") return send(200, { id: `${job.id}:1`, status: "stopped" });
      if (one[3] === "reset") return send(200, preview(job));
    }
    if (url.pathname === "/runs") return send(200, [{ id: "j1:1", jobId: "j1", scheduledAt: 1, status: "finished", summary: "ok", startedAt: 1, finishedAt: 2, sessionId: "s1" }]);
    if (url.pathname === "/runs/j1%3A1") return send(200, { id: "j1:1", jobId: "j1", scheduledAt: 1, status: "finished", summary: "ok", startedAt: 1, finishedAt: 2, sessionId: "s1", answer: "All good" });
    if (url.pathname === "/questions") return send(200, questions);
    if (req.method === "POST" && url.pathname === "/questions/s9%2Fq1/answer") return send(200, { ...questions[0], status: "answered", answer: record.body.answer });
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, seen, jobs, refuseWith: (message?: string) => (refuse = message), close: (() => {
      let closed = false;
      return () => (closed ? Promise.resolve() : ((closed = true), new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())))));
    })() };
}

async function setup() {
  const t = await tempStore();
  const token = newToken();
  const scheduler = await stubScheduler();
  process.env.DURABLE_JIM_URL = scheduler.url;
  process.env.DURABLE_JIM_TOKEN = "scheduler-secret";
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.base}/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const created = await (await call("/sessions", { method: "POST", body: JSON.stringify({ name: "Manager", cwd: t.work, model: faux }) })).json();
  const base = `/sessions/${created.id}/agents/main`;
  let n = 0;
  const say = async (content: string) => {
    const sent = await (await call(`${base}/messages`, { method: "POST", body: JSON.stringify({ content, requestId: `m-${++n}` }) })).json();
    return sent.submissionId as number;
  };
  const settle = async (submissionId: number) => {
    const done = await (await call(`/sessions/${created.id}/submissions/${submissionId}?waitMs=20000`)).json();
    return done as { status: string; answer?: { text: string } };
  };
  const pending = async () => {
    const { value } = (await (await call(`${base}/docs/jim.attention`)).json()) as { value: Attention };
    return Object.values(value.questions ?? {}).find((q) => q.status === "pending");
  };
  const answer = async (id: string, text: string) => call(`${base}/questions/${id}/answer`, { method: "POST", body: JSON.stringify({ answer: text }) });
  const enable = () => call(`${base}/extensions`, { method: "PATCH", body: JSON.stringify({ name: "durable-jim-manager", enabled: true }) });
  return { t, scheduler, call, base, say, settle, pending, answer, enable, created, close: async () => (await server.stop(), await scheduler.close(), await t.cleanup()) };
}

const remind = { name: "Call the bank", prompt: "Remind the user to call the bank.", schedule: { kind: "once", at: "2026-10-29T17:00:00-05:00" } };

test("the Manager tools are an optional extension: listed, off by default, and absent until turned on", async () => {
  const m = await setup();
  try {
    const listed = (await (await m.call(`${m.base}/extensions`)).json()) as { extensions: { name: string; title: string; enabled: boolean }[] };
    const ext = listed.extensions.find((e) => e.name === "durable-jim-manager");
    assert.ok(ext, "listed");
    assert.equal(ext.title, "durable-jim Manager");
    assert.equal(ext.enabled, false, "off by default");

    const before = await m.settle(await m.say("manage: list_jobs"));
    assert.doesNotMatch(before.answer!.text, /Daily Digest/, "without the extension there is no such tool");

    assert.equal((await m.enable()).status, 200);
    const after = await m.settle(await m.say("manage: list_jobs"));
    assert.match(after.answer!.text, /Daily Digest \[active\] cron "0 7 \* \* \*" \(America\/Chicago\) next 2026-10-30T12:00:00Z/);
    assert.equal(m.scheduler.seen[0]!.auth, "Bearer scheduler-secret", "calls the Scheduler with its token");
  } finally {
    await m.close();
  }
});

test("create_job shows the preview as an Approve/Deny question and saves only once approved", async () => {
  const m = await setup();
  try {
    await m.enable();
    const turn = await m.say(`manage: create_job ${JSON.stringify(remind)}`);
    await until(async () => (await m.pending()) !== undefined, 15000, "the confirmation question");
    const q = (await m.pending())!;
    assert.match(q.question, /Save this job\?/);
    assert.match(q.question, /Name: Call the bank/);
    assert.match(q.question, /Schedule: once at 2026-10-29T17:00:00-05:00/);
    assert.match(q.question, /Next runs: 2026-10-29T22:00:00\.000Z/);
    assert.deepEqual(q.choices, ["Approve", "Deny"]);
    assert.deepEqual(m.scheduler.seen.filter((r) => r.method === "POST" && r.path === "/jobs"), [], "nothing is saved yet");
    assert.equal(m.scheduler.seen.filter((r) => r.path === "/jobs?dryRun=true").length, 1);

    await m.answer(q.id, "Approve");
    const done = await m.settle(turn);
    assert.match(done.answer!.text, /Saved job "Call the bank"/);
    assert.deepEqual(m.scheduler.seen.filter((r) => r.method === "POST" && r.path === "/jobs")[0]!.body, remind);
  } finally {
    await m.close();
  }
});

test("a Deny, or a reply in the user's own words, saves nothing and the Manager is told why", async () => {
  const m = await setup();
  try {
    await m.enable();
    const first = await m.say(`manage: create_job ${JSON.stringify(remind)}`);
    await until(async () => (await m.pending()) !== undefined, 15000, "the question");
    await m.answer((await m.pending())!.id, "Deny");
    assert.match((await m.settle(first)).answer!.text, /Not saved: the user declined/);

    const second = await m.say(`manage: create_job ${JSON.stringify(remind)}`);
    await until(async () => (await m.pending()) !== undefined, 15000, "the second question");
    await m.answer((await m.pending())!.id, "make it 6 instead");
    assert.match((await m.settle(second)).answer!.text, /the user replied "make it 6 instead"/);
    assert.deepEqual(m.scheduler.seen.filter((r) => r.method === "POST" && r.path === "/jobs"), []);
  } finally {
    await m.close();
  }
});

test("update_job and delete_job also wait for approval; the job is found by name in any case", async () => {
  const m = await setup();
  try {
    await m.enable();
    const patch = await m.say('manage: update_job {"job":"daily digest","notifyMode":"when-needed"}');
    await until(async () => (await m.pending()) !== undefined, 15000, "the change question");
    assert.match((await m.pending())!.question, /Change "Daily Digest" like this\?/);
    await m.answer((await m.pending())!.id, "Approve");
    assert.match((await m.settle(patch)).answer!.text, /Updated "Daily Digest"/);
    assert.deepEqual(m.scheduler.seen.find((r) => r.method === "PATCH" && !r.path.includes("dryRun"))!.body, { notifyMode: "when-needed" });

    const del = await m.say('manage: delete_job {"job":"Daily Digest"}');
    await until(async () => (await m.pending()) !== undefined, 15000, "the delete question");
    assert.match((await m.pending())!.question, /Delete "Daily Digest"\?/);
    await m.answer((await m.pending())!.id, "Deny");
    assert.match((await m.settle(del)).answer!.text, /Not deleted/);
    assert.deepEqual(m.scheduler.seen.filter((r) => r.method === "DELETE"), []);
  } finally {
    await m.close();
  }
});

test("run, stop, reset, the run lists and the question list need no approval", async () => {
  const m = await setup();
  try {
    await m.enable();
    const out = async (prompt: string) => (await m.settle(await m.say(prompt))).answer!.text;
    assert.match(await out('manage: run_job_now {"job":"Daily Digest"}'), /Started a run of "Daily Digest" \(j1:1\)/);
    assert.match(await out('manage: stop_run {"job":"Daily Digest"}'), /Stopped the run of "Daily Digest" \(stopped\)/);
    assert.match(await out('manage: reset_job {"job":"Daily Digest"}'), /Reset "Daily Digest"/);
    assert.match(await out("manage: list_runs"), /Daily Digest \[finished\] - ok \(j1:1\)/);
    assert.match(await out('manage: show_run {"run":"j1:1"}'), /Answer: All good/);
    assert.match(await out("manage: list_questions"), /s9\/q1: Deploy it\? \[Approve \/ Deny\]/);
    assert.equal(await m.pending(), undefined, "none of these asked the user anything");
  } finally {
    await m.close();
  }
});

test("answer_question shows the question and the answer and sends only once approved", async () => {
  const m = await setup();
  try {
    await m.enable();
    const turn = await m.say('manage: answer_question {"question":"s9/q1","answer":"Approve"}');
    await until(async () => (await m.pending()) !== undefined, 15000, "the confirmation");
    const q = (await m.pending())!;
    assert.match(q.question, /Deploy it\?/);
    assert.match(q.question, /Answer: Approve/);
    assert.deepEqual(m.scheduler.seen.filter((r) => r.path.endsWith("/answer")), []);
    await m.answer(q.id, "Approve");
    assert.match((await m.settle(turn)).answer!.text, /Answered "Deploy it\?" with "Approve"/);
    assert.deepEqual(m.scheduler.seen.find((r) => r.path.endsWith("/answer"))!.body, { answer: "Approve" });
  } finally {
    await m.close();
  }
});

test("answer_question refuses an ambiguous start of an id instead of picking one", async () => {
  const m = await setup();
  try {
    await m.enable();
    const out = async (prompt: string) => (await m.settle(await m.say(prompt))).answer!.text;
    assert.match(await out('manage: answer_question {"question":"s9/q","answer":"Approve"}'), /matches more than one question \(s9\/q1; s9\/q10\)/);
    assert.match(await out('manage: answer_question {"question":"zzz","answer":"Approve"}'), /no pending question "zzz"/);
  } finally {
    await m.close();
  }
});

test("the Scheduler's refusals and an unknown job come back as the tool's error, in its own words", async () => {
  const m = await setup();
  try {
    await m.enable();
    const out = async (prompt: string) => (await m.settle(await m.say(prompt))).answer!.text;
    assert.match(await out('manage: run_job_now {"job":"Nope"}'), /no job called "Nope" \(jobs: Daily Digest\)/);
    m.scheduler.refuseWith("the job's previous run still active");
    assert.match(await out("manage: list_jobs"), /previous run still active/);
  } finally {
    await m.close();
  }
});

test("when the Scheduler is not reachable the tool says so", async () => {
  const m = await setup();
  try {
    await m.enable();
    await m.scheduler.close();
    assert.match((await m.settle(await m.say("manage: list_jobs"))).answer!.text, /Can't reach the Scheduler/);
  } finally {
    await m.close();
  }
});

test("the Manager's instructions are constant text and say where the time comes from", () => {
  assert.match(MANAGER_PROMPT, /Each message starts with a line in square brackets giving the time/);
  assert.match(MANAGER_PROMPT, /ISO time with its offset/);
  assert.doesNotMatch(MANAGER_PROMPT, /\b20\d\d-\d\d-\d\d\b/, "no date baked in: a prompt section must render the same every time");
});

test("a confirmation times out as a no after half an hour, not the 12 hours of an ordinary question", async () => {
  const m = await setup();
  try {
    await m.enable();
    await m.say(`manage: create_job ${JSON.stringify(remind)}`);
    await until(async () => (await m.pending()) !== undefined, 15000, "the question");
    const q = (await m.pending())!;
    assert.equal(q.timeoutAt - q.askedAt, CONFIRM_TIMEOUT_S * 1000);
    await m.answer(q.id, "Deny");
  } finally {
    await m.close();
  }
});
