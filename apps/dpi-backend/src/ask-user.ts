// Lets an unattended run stop and ask the user something, wait durably for the answer, and flag messages for them.
//
// A question is a row in the conversation's `jim.attention` document plus a durable `ask.question` task that owns the
// wait. The document is how the Scheduler learns about questions (it streams as `doc` frames) and how it answers them
// (`answerQuestion`, behind the one new HTTP route). The task only sleeps (`sleepUntil`) to the next deadline: it
// sends the reminder after an hour and answers "No answer: denied" at the timeout. The tool call watches the document
// for an answer with cheap reads, so a waiting question writes nothing. All of it survives a restart.
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTask, defineTool, section, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ApiFault, invalid, notFound } from "./errors.js";

const HOUR_MS = 3_600_000;
export const DEFAULT_TIMEOUT_MS = 12 * HOUR_MS;
export const REMINDER_MS = HOUR_MS;
export const NO_ANSWER = "No answer: denied";
/** How often the tool call looks for an answer. Reads only. */
const WATCH_MS = 500;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Question = {
  id: string;
  callId: string;
  taskId: number;
  question: string;
  choices?: string[];
  askedAt: number;
  timeoutAt: number;
  remindedAt?: number;
  status: "pending" | "answered" | "cancelled";
  answer?: string;
  answeredBy?: "user" | "timeout";
  answeredAt?: number;
};
export type Notice = {
  id: string;
  callId: string;
  message: string;
  at: number;
};
export type Attention = {
  seq: number;
  questions: Record<string, Question>;
  notices: Notice[];
  /** Set by the Scheduler before it starts a run, to just before the job's next fire; no question waits past it. */
  answerBy?: number;
};

export const ATTENTION_DOC = "jim.attention";
export const AttentionDoc = defineDoc<Attention>({
  kind: ATTENTION_DOC,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ seq: 0, questions: {}, notices: [] }),
  checkpointWhen: () => false,
});

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The task that owns one question's deadlines. It ends with the question answered, by the user or by the timeout. */
const WaitTask = defineTask<{ id: string }, { phase: "wait" }, { answer: string }>({
  name: "ask.question",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const doc = await runtime.snapshot(AttentionDoc, task.conversationId, context);
      const question = doc?.questions[task.input.id];
      if (!doc || !question) throw Error(`No question ${task.input.id}`);
      if (question.status !== "pending") {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: { answer: question.answer ?? NO_ANSWER } } }),
          context,
        );
        return;
      }
      const now = runtime.now();
      const due = Math.min(question.timeoutAt, doc.answerBy ?? Infinity);
      if (now >= due) {
        await runtime.commit(async (tx) => {
          const current = (await tx.doc(AttentionDoc, task.conversationId)).questions[task.input.id];
          if (current.status === "pending") {
            current.status = "answered";
            current.answer = NO_ANSWER;
            current.answeredBy = "timeout";
            current.answeredAt = now;
          }
          return { status: "terminal", outcome: { status: "completed", result: { answer: current.answer ?? NO_ANSWER } } };
        }, context);
        return;
      }
      const remindAt = question.askedAt + REMINDER_MS;
      let reminded = question.remindedAt !== undefined;
      if (!reminded && now >= remindAt && remindAt < due) {
        await runtime.commit(async (tx) => {
          const current = (await tx.doc(AttentionDoc, task.conversationId)).questions[task.input.id];
          if (current.status === "pending") current.remindedAt = now;
          return undefined;
        }, context);
        reminded = true;
      }
      const next = Math.min(due, reminded ? Infinity : remindAt);
      await runtime.sleepUntil(next, task.state.checkpoint, context);
    },
  },
  abort: async (task, runtime, context) => {
    await runtime.commit(async (tx) => {
      const current = (await tx.doc(AttentionDoc, task.conversationId)).questions[task.input.id];
      if (current?.status === "pending") current.status = "cancelled";
      return { status: "terminal", outcome: { status: "aborted" } };
    }, context);
  },
});

/** Records a user's answer. The first one wins; a later one is rejected, whichever channel it came from. */
export async function answerQuestion(h: Harness, c: Conversation, id: string, answer: unknown) {
  if (typeof answer !== "string" || !answer.trim() || answer.length > 10_000)
    throw invalid("answer must be text under 10,000 characters");
  const question = await c.commit(async (tx) => {
    const found = (await tx.doc(AttentionDoc, c.id)).questions[id];
    if (!found) throw notFound(`No question ${id}`);
    if (found.status !== "pending") throw new ApiFault("conflict", `Question ${id} is already ${found.status}`);
    found.status = "answered";
    found.answer = answer.trim();
    found.answeredBy = "user";
    found.answeredAt = Date.now();
    return plain(found);
  }, BACKGROUND_CONTEXT);
  // Its task is asleep until the next deadline; ending it lets the waiting tool call finish now.
  // Best effort: the answer is stored either way, and the task ends on its own at its deadline.
  await h.abortTask(question.taskId as never, BACKGROUND_CONTEXT).catch(() => undefined);
  return { ok: true as const, question };
}

export function createAskUser() {
  const ask = defineTool({
    name: "ask_user",
    description:
      "Ask the user a question and wait for their answer. Use it when you need a decision or approval you cannot make yourself. Pass choices for a short list of options; the user can still reply in their own words. The wait survives restarts. If nobody answers in time, the answer is \"No answer: denied\": treat it as a refusal, carry on without the thing you asked about, and say what you could not do. Optional timeout is in seconds (default 12 hours).",
    parameters: Type.Object({
      question: Type.String({ description: "What you need to know, in one or two sentences." }),
      choices: Type.Optional(Type.Array(Type.String(), { description: "Options to offer, such as [\"Approve\", \"Deny\"]." })),
      timeout: Type.Optional(Type.Number({ description: "Seconds to wait before treating it as denied." })),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      if (args.timeout !== undefined && !(args.timeout > 0)) throw Error("timeout must be a positive number of seconds");
      const timeoutMs = args.timeout !== undefined ? args.timeout * 1000 : DEFAULT_TIMEOUT_MS;
      // A replay after a crash finds the question this call asked instead of asking again.
      const asked = await api.commit(async (tx) => {
        const doc = await tx.doc(AttentionDoc, api.conversationId);
        const found = Object.values(doc.questions).find((q) => q.callId === api.callId);
        if (found) return plain(found);
        doc.seq += 1;
        const id = `q${doc.seq}`;
        const askedAt = api.now();
        const taskId = await tx.createTask(
          WaitTask,
          { id },
          { ownership: { kind: "task", taskId: api.taskId }, background: false },
        );
        const created: Question = {
          id,
          callId: api.callId,
          taskId: taskId as number,
          question: args.question,
          ...(args.choices?.length ? { choices: args.choices } : {}),
          askedAt,
          timeoutAt: askedAt + timeoutMs,
          status: "pending",
        };
        doc.questions[id] = created;
        return plain(created);
      }, context);
      await api.details({ questionId: asked.id }, context);
      // The question's task sleeps to its deadlines. This call sees the answer, from the user or the timeout, as it lands.
      const read = async () => (await api.snapshot(AttentionDoc, api.conversationId, context))?.questions[asked.id];
      let current = await read();
      while (current?.status === "pending") {
        await pause(WATCH_MS);
        current = await read();
      }
      if (current?.status === "cancelled")
        return { output: [{ type: "text", text: "The question was cancelled before anyone answered." }], isError: true };
      return {
        output: [{ type: "text", text: current?.answer ?? NO_ANSWER }],
        details: { questionId: asked.id, answeredBy: current?.answeredBy ?? "timeout" },
      };
    },
  });
  const notify = defineTool({
    name: "notify",
    description:
      "Flag a message for the user. Use it when the user asked to hear about something only if it matters, such as a failing build. The message is sent to them; it does not stop your run.",
    parameters: Type.Object({ message: Type.String({ description: "What the user needs to know, in a few lines." }) }),
    replay: "safe",
    execute: async (args, api, context) => {
      await api.commit(async (tx) => {
        const doc = await tx.doc(AttentionDoc, api.conversationId);
        if (doc.notices.some((n) => n.callId === api.callId)) return;
        doc.seq += 1;
        doc.notices.push({ id: `n${doc.seq}`, callId: api.callId, message: args.message, at: api.now() });
      }, context);
      return { output: [{ type: "text", text: "The user will be notified." }] };
    },
  });
  return defineExtension({
    name: "ask-user",
    tasks: [WaitTask],
    tools: [ask, notify],
    sections: [
      section(
        "ask-user",
        () =>
          "You may be running with nobody watching. Use ask_user when you need a decision or approval; do not guess. Use notify to flag something the user should see.",
        { tag: false },
      ),
    ],
  });
}
