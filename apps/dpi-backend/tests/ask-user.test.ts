// ask_user and notify, in a real pi-durable harness on temporary SQLite with the scripted faux model and a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness, createRegistry, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { messageText } from "../../dpi-sdk/src/transcript.js";
import { installFaux } from "../src/faux.js";
import {
  AttentionDoc,
  DEFAULT_TIMEOUT_MS,
  NO_ANSWER,
  REMINDER_MS,
  answerQuestion,
  setAttention,
  createAskUser,
  type Attention,
} from "../src/ask-user.js";
import { bootServer, delay, faux, newToken, tempStore, until } from "./helpers.js";

/** A clock the test advances. Timers fire in order as it passes them. */
function fakeClock(start = 1_700_000_000_000) {
  let time = start;
  let pending: { at: number; run: () => void }[] = [];
  return {
    now: () => time,
    setTimer: (run: () => void, delayMs: number) => {
      const timer = { at: time + delayMs, run };
      pending.push(timer);
      return () => void (pending = pending.filter((t) => t !== timer));
    },
    /** Move time forward without firing timers, as if the process was down meanwhile. */
    jump(ms: number) {
      time += ms;
      pending = [];
    },
    async advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const next = pending.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        pending = pending.filter((t) => t !== next);
        time = Math.max(time, next.at);
        next.run();
        await delay(20);
      }
      time = end;
      await delay(20);
    },
  };
}

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-ask-")));
  const dbPath = join(root, "session.db");
  const clock = fakeClock();
  const models = createModels();
  installFaux(models);
  const askUser = createAskUser();
  const open = async () => {
    const registry = createRegistry();
    registry.install(askUser);
    const harness = await Harness.open(
      await openNodeSqliteStorage(dbPath),
      { models, registry, now: clock.now, setTimer: clock.setTimer, settings: { extensions: [askUser] } },
      ctx,
    );
    const rootConversation = await harness.root(ctx, { agent: { cwd: root, model: { provider: "faux", modelId: "echo" } } });
    harness.resume();
    return { harness, c: rootConversation as Conversation };
  };
  let session = await open();
  let n = 0;
  const say = async (content: string) => {
    const submission = await session.c.submit({ type: "input", content, requestId: `r${++n}`, whenBusy: "followUp" }, ctx);
    return submission.id as number;
  };
  const doc = async (): Promise<Attention> =>
    JSON.parse(JSON.stringify((await session.harness.snapshot(AttentionDoc, session.c.id, ctx)) ?? { seq: 0, questions: {}, notices: [] }));
  const reply = async (submissionId: number) => {
    const submission = (await session.harness.submission(submissionId as never, ctx))!;
    const record = await submission.status(ctx);
    if (record.status !== "done" || record.answer === undefined) return undefined;
    const entry = await session.harness.commit((tx) => tx.entry(record.answer as never), ctx);
    return (entry?.model ?? []).map((m) => messageText(m as never)).join("").trim();
  };
  return {
    clock,
    say,
    doc,
    reply,
    get c() {
      return session.c;
    },
    get harness() {
      return session.harness;
    },
    /** Close the harness and open the same database again, as after a restart; `downMs` passes while it is closed. */
    async restart(downMs = 0) {
      await session.harness.close(ctx);
      clock.jump(downMs);
      session = await open();
    },
    /** Wait for the first question to be asked. */
    async question() {
      await until(async () => Object.keys((await doc()).questions).length > 0, 10000, "a question");
      return Object.values((await doc()).questions)[0];
    },
    async cleanup() {
      await session.harness.close(ctx).catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("ask_user stores the question, waits, and hands the answer back to the agent", async () => {
  const t = await setup();
  try {
    const turn = await t.say("ask: Deploy to staging? | Approve | Deny");
    const q = await t.question();
    assert.equal(q.question, "Deploy to staging?");
    assert.deepEqual(q.choices, ["Approve", "Deny"]);
    assert.equal(q.status, "pending");
    assert.equal(await t.reply(turn), undefined, "the agent is still waiting");

    const result = await answerQuestion(t.harness, t.c, q.id, "Approve");
    assert.equal(result.question.status, "answered");
    await until(async () => (await t.reply(turn)) !== undefined, 10000, "the agent to continue");
    assert.match((await t.reply(turn))!, /Tool finished: Approve/);
    assert.equal((await t.doc()).questions[q.id].answeredBy, "user");
  } finally {
    await t.cleanup();
  }
});

test("a free-text answer works even when there are choices", async () => {
  const t = await setup();
  try {
    const turn = await t.say("ask: Which environment? | staging | prod");
    const q = await t.question();
    await answerQuestion(t.harness, t.c, q.id, "neither — use the sandbox");
    await until(async () => (await t.reply(turn)) !== undefined, 10000, "the agent to continue");
    assert.match((await t.reply(turn))!, /neither — use the sandbox/);
  } finally {
    await t.cleanup();
  }
});

test("the first answer wins and later answers are rejected as already answered", async () => {
  const t = await setup();
  try {
    await t.say("ask: Proceed? | Approve | Deny");
    const q = await t.question();
    await answerQuestion(t.harness, t.c, q.id, "Deny");
    await assert.rejects(
      () => answerQuestion(t.harness, t.c, q.id, "Approve"),
      (e: { code?: string; message?: string }) => e.code === "conflict" && /already answered/.test(e.message ?? ""),
    );
    assert.equal((await t.doc()).questions[q.id].answer, "Deny");
    await assert.rejects(() => answerQuestion(t.harness, t.c, "q99", "Approve"), (e: { code?: string }) => e.code === "not_found");
    await assert.rejects(() => answerQuestion(t.harness, t.c, q.id, "   "), (e: { code?: string }) => e.code === "invalid");
  } finally {
    await t.cleanup();
  }
});

test("a waiting question survives a harness close and reopen, and can still be answered", async () => {
  const t = await setup();
  try {
    const turn = await t.say("ask: Delete the old branch? | Approve | Deny");
    const q = await t.question();
    await t.clock.advance(10 * 60_000);
    await t.restart();
    assert.equal((await t.doc()).questions[q.id].status, "pending");
    // Still one question: reopening did not ask again.
    assert.equal(Object.keys((await t.doc()).questions).length, 1);

    await answerQuestion(t.harness, t.c, q.id, "Deny");
    await until(async () => (await t.reply(turn)) !== undefined, 10000, "the agent to continue after the restart");
    assert.match((await t.reply(turn))!, /Tool finished: Deny/);
  } finally {
    await t.cleanup();
  }
});

test("a question whose timeout passed while the Backend was down is denied on reopen", async () => {
  const t = await setup();
  try {
    const turn = await t.say("ask: Anyone there? | timeout=60");
    const q = await t.question();
    await t.restart(2 * 60_000);
    await until(async () => (await t.reply(turn)) !== undefined, 10000, "the agent to continue");
    assert.match((await t.reply(turn))!, new RegExp(NO_ANSWER));
    assert.equal((await t.doc()).questions[q.id].answeredBy, "timeout");
  } finally {
    await t.cleanup();
  }
});

test("stopping the run cancels its pending question instead of denying it", async () => {
  const t = await setup();
  try {
    await t.say("ask: Continue? | Approve | Deny");
    const q = await t.question();
    await t.c.abort(ctx);
    await until(async () => (await t.doc()).questions[q.id].status !== "pending", 10000, "the question to settle");
    assert.equal((await t.doc()).questions[q.id].status, "cancelled");
    await assert.rejects(() => answerQuestion(t.harness, t.c, q.id, "Approve"), (e: { code?: string }) => e.code === "conflict");
  } finally {
    await t.cleanup();
  }
});

test("an unanswered question sends one reminder after an hour", async () => {
  const t = await setup();
  try {
    await t.say("ask: Still there?");
    const q = await t.question();
    await t.clock.advance(REMINDER_MS - 60_000);
    assert.equal((await t.doc()).questions[q.id].remindedAt, undefined, "no reminder before the hour");
    await t.clock.advance(120_000);
    await until(async () => (await t.doc()).questions[q.id].remindedAt !== undefined, 10000, "the reminder");
    const remindedAt = (await t.doc()).questions[q.id].remindedAt;
    assert.ok(remindedAt! >= q.askedAt + REMINDER_MS);
    await t.clock.advance(30 * 60_000);
    assert.equal((await t.doc()).questions[q.id].remindedAt, remindedAt, "only one reminder");
    assert.equal((await t.doc()).questions[q.id].status, "pending");
  } finally {
    await t.cleanup();
  }
});

test("with no answer, the question is denied after 12 hours and the agent carries on", async () => {
  const t = await setup();
  try {
    const turn = await t.say("ask: Approve the migration? | Approve | Deny");
    const q = await t.question();
    await t.clock.advance(DEFAULT_TIMEOUT_MS - 60_000);
    assert.equal((await t.doc()).questions[q.id].status, "pending");
    await t.clock.advance(120_000);
    await until(async () => (await t.reply(turn)) !== undefined, 10000, "the agent to continue");
    assert.match((await t.reply(turn))!, new RegExp(`Tool finished: ${NO_ANSWER}`));
    const done = (await t.doc()).questions[q.id];
    assert.equal(done.status, "answered");
    assert.equal(done.answer, NO_ANSWER);
    assert.equal(done.answeredBy, "timeout");
    await assert.rejects(() => answerQuestion(t.harness, t.c, q.id, "Approve"), (e: { code?: string }) => e.code === "conflict");
  } finally {
    await t.cleanup();
  }
});

test("a per-call timeout replaces the default", async () => {
  const t = await setup();
  try {
    const turn = await t.say("ask: Quick one? | timeout=30");
    const q = await t.question();
    assert.equal(q.timeoutAt, q.askedAt + 30_000);
    await t.clock.advance(31_000);
    await until(async () => (await t.reply(turn)) !== undefined, 10000, "the agent to continue");
    assert.match((await t.reply(turn))!, new RegExp(NO_ANSWER));
  } finally {
    await t.cleanup();
  }
});

test("no question waits past the Scheduler's answer-by time", async () => {
  const t = await setup();
  try {
    // The Scheduler sets the cap before the run starts, to just before the job's next fire.
    const answerBy = t.clock.now() + 5 * 60_000;
    await t.c.commit(async (tx) => {
      (await tx.doc(AttentionDoc, t.c.id)).answerBy = answerBy;
    }, ctx);
    const turn = await t.say("ask: Before the next run?");
    const q = await t.question();
    await t.clock.advance(4 * 60_000);
    assert.equal((await t.doc()).questions[q.id].status, "pending");
    await t.clock.advance(2 * 60_000);
    await until(async () => (await t.reply(turn)) !== undefined, 10000, "the agent to continue");
    assert.match((await t.reply(turn))!, new RegExp(NO_ANSWER));
  } finally {
    await t.cleanup();
  }
});

test("notify marks a message for the Scheduler and the run carries on", async () => {
  const t = await setup();
  try {
    const turn = await t.say("notify: The build is broken");
    await until(async () => (await t.reply(turn)) !== undefined, 10000, "the agent to finish");
    assert.deepEqual(
      (await t.doc()).notices.map((n) => n.message),
      ["The build is broken"],
    );
    assert.match((await t.reply(turn))!, /Tool finished: The user will be notified/);
  } finally {
    await t.cleanup();
  }
});

test("the answer route: authenticated, first answer wins, a second gets 409, an unknown question 404", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.base}/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  try {
    const created = await (await call("/sessions", { method: "POST", body: JSON.stringify({ name: "Asker", cwd: t.work, model: faux }) })).json();
    const base = `/sessions/${created.id}/agents/main`;
    const sent = await call(`${base}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: "ask: Ship it? | Approve | Deny", requestId: "ask-1" }),
    });
    const { submissionId } = await sent.json();
    const pending = async () => {
      const { value } = (await (await call(`${base}/docs/jim.attention`)).json()) as { value: Attention };
      return Object.values(value.questions ?? {}).find((q) => q.status === "pending");
    };
    await until(async () => (await pending()) !== undefined, 15000, "the question in the document");
    const q = (await pending())!;

    const anon = await fetch(`${server.base}/v1${base}/questions/${q.id}/answer`, { method: "POST" });
    assert.equal(anon.status, 401);
    assert.equal((await call(`${base}/questions/q99/answer`, { method: "POST", body: JSON.stringify({ answer: "x" }) })).status, 404);
    assert.equal((await call(`${base}/questions/${q.id}/answer`, { method: "POST", body: JSON.stringify({}) })).status, 400);

    const first = await call(`${base}/questions/${q.id}/answer`, { method: "POST", body: JSON.stringify({ answer: "Approve" }) });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as { question: { answer: string } }).question.answer, "Approve");
    const second = await call(`${base}/questions/${q.id}/answer`, { method: "POST", body: JSON.stringify({ answer: "Deny" }) });
    assert.equal(second.status, 409);

    const done = await call(`/sessions/${created.id}/submissions/${submissionId}?waitMs=15000`);
    const body = (await done.json()) as { status: string; answer?: { text: string } };
    assert.equal(body.status, "done");
    assert.match(body.answer!.text, /Tool finished: Approve/);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("setAttention merges trusted and answerBy, keeps questions and notices, and null clears answerBy", async () => {
  const t = await setup();
  try {
    const turn = await t.say("ask: Ship it? | Approve | Deny");
    const q = await t.question();
    await setAttention(t.c, { trusted: true, answerBy: t.clock.now() + 60_000 });
    let doc = await t.doc();
    assert.equal(doc.trusted, true);
    assert.equal(doc.answerBy, t.clock.now() + 60_000);
    assert.equal(doc.questions[q.id].status, "pending", "the question survives");

    await setAttention(t.c, { trusted: false, answerBy: null });
    doc = await t.doc();
    assert.equal(doc.trusted, false);
    assert.ok(!("answerBy" in doc), "null removes the field");
    assert.equal(doc.questions[q.id].status, "pending");

    await setAttention(t.c, { trusted: true });
    assert.equal((await t.doc()).trusted, true);
    await answerQuestion(t.harness, t.c, q.id, "Approve");
    await t.reply(turn);
  } finally {
    await t.cleanup();
  }
});

test("setAttention refuses a body with nothing to set or a bad value", async () => {
  const t = await setup();
  try {
    for (const body of [{}, { trusted: "yes" }, { answerBy: "soon" }, { answerBy: -1 }, { answerBy: Number.NaN }, null, "x"]) {
      await assert.rejects(() => setAttention(t.c, body), /trusted|answerBy|body/, JSON.stringify(body));
    }
    assert.deepEqual(await t.doc(), { seq: 0, questions: {}, notices: [] });
  } finally {
    await t.cleanup();
  }
});

test("the attention route: authenticated, sets trusted and answerBy, validates, and 404s an unknown session", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.base}/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
  try {
    const created = await (await call("/sessions", { method: "POST", body: JSON.stringify({ name: "Att", cwd: t.work, model: faux }) })).json();
    const base = `/sessions/${created.id}/agents/main`;
    const put = (b: unknown, path = `${base}/attention`) => call(path, { method: "PUT", body: JSON.stringify(b) });

    assert.equal((await fetch(`${server.base}/v1${base}/attention`, { method: "PUT" })).status, 401);
    assert.equal((await put({})).status, 400);
    assert.equal((await put({ trusted: true }, "/sessions/nope/agents/main/attention")).status, 404);

    const ok = await put({ trusted: true, answerBy: 4_000_000_000_000 });
    assert.equal(ok.status, 200);
    const read = async () => ((await (await call(`${base}/docs/jim.attention`)).json()) as { value: Attention }).value;
    assert.equal((await read()).trusted, true);
    assert.equal((await read()).answerBy, 4_000_000_000_000);

    assert.equal((await put({ trusted: false, answerBy: null })).status, 200);
    const cleared = await read();
    assert.equal(cleared.trusted, false);
    assert.ok(!("answerBy" in cleared));
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
