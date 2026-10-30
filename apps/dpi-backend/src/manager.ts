// The Manager's job tools: thin wrappers over the Scheduler's localhost API (durable-jim-agent). Installed in every
// session as an optional extension; only the Manager session turns it on. Saving, changing or deleting a job, and
// answering a question, are shown to the user first and happen only if they approve (the same durable question
// `ask_user` uses, so it reaches their phone as Approve/Deny buttons).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, section, ToolTask, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { askAndWait, NO_ANSWER } from "./ask-user.js";
import type { Job, Preview, Question, Run } from "./scheduler-shapes.js";
import { describeSchedule, findJob, formatPreview } from "./scheduler-reading.js";

export const MANAGER_EXTENSION = "durable-jim-manager";

/** The Scheduler, as these tools need it: one call that returns the parsed reply or throws with the Scheduler's own message. */
export interface SchedulerApi {
  request(method: string, path: string, body?: unknown, approval?: string): Promise<any>;
}

/**
 * Where the Scheduler listens, and the Manager's own credential for it: `DURABLE_JIM_URL` and `DURABLE_JIM_MANAGER_TOKEN`,
 * else the `client.json` the Scheduler writes in its state directory. Never the Scheduler's full `token`: with the
 * Manager's credential a change goes through only with the id of a question the user approved (`x-approval`).
 */
export function schedulerFromEnvironment(env: NodeJS.ProcessEnv = process.env): SchedulerApi {
  const endpoint = () => {
    if (env.DURABLE_JIM_URL && env.DURABLE_JIM_MANAGER_TOKEN) return { url: env.DURABLE_JIM_URL, token: env.DURABLE_JIM_MANAGER_TOKEN };
    try {
      const file = JSON.parse(readFileSync(join(env.DURABLE_JIM_HOME ?? join(homedir(), ".durable-jim-agent"), "client.json"), "utf8"));
      if (typeof file.url === "string" && typeof file.managerToken === "string") return { url: file.url, token: file.managerToken };
    } catch {
      // Falls through to the one message below.
    }
    throw new Error("Can't find the Scheduler (or its Manager credential). Is it running, and up to date?");
  };
  return {
    async request(method, path, body, approval) {
      // Read on every call: the Scheduler may have restarted on another port.
      const { url, token } = endpoint();
      let response: Response;
      try {
        response = await fetch(`${url}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(approval ? { "x-approval": approval } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        // A write that timed out may still have gone through: say so, so it is checked before it is tried again.
        if (method !== "GET" && (error as { name?: string }).name === "TimeoutError") throw new Error("The Scheduler did not answer in time. The change may have gone through: check with list_jobs before trying again.");
        throw new Error(`Can't reach the Scheduler at ${url}. Is it running?`);
      }
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        throw new Error(`Got an unreadable reply from the Scheduler (HTTP ${response.status}).`);
      }
      if (!response.ok) throw new Error((parsed as { error?: string } | undefined)?.error ?? `HTTP ${response.status}`);
      return parsed;
    },
  };
}

// ---------------------------------------------------------------- shapes (what the Scheduler returns; see scheduler-shapes.ts)

const iso = (ms: number | null) => (ms === null ? "-" : new Date(ms).toISOString().replace(".000Z", "Z"));

const formatJobLine = (job: Job) => `${job.name} [${job.status}] ${describeSchedule(job)}${job.status === "active" ? ` next ${iso(job.nextFireAt)}` : ""}`;
const formatRunLine = (run: Run, names: Map<string, string>) =>
  `${iso(run.scheduledAt)} ${names.get(run.jobId) ?? run.jobId} [${run.status}]${run.summary ? ` - ${run.summary}` : ""} (${run.id})`;

const text = (value: string, details?: object): ToolExecutionResult => ({ output: [{ type: "text", text: value }], ...(details !== undefined ? { details: details as ToolExecutionResult["details"] } : {}) });
const failure = (message: string): ToolExecutionResult => ({ output: [{ type: "text", text: message }], isError: true });

// ---------------------------------------------------------------- schema

const Schedule = Type.Union(
  [
    Type.Object({ kind: Type.Literal("once"), at: Type.String({ description: "ISO 8601 time with an offset, such as 2026-11-02T17:00:00-06:00" }) }),
    Type.Object({
      kind: Type.Literal("cron"),
      expr: Type.String({ description: "Five-field cron: minute hour day-of-month month weekday" }),
      timezone: Type.String({ description: "IANA timezone, such as America/Chicago" }),
    }),
  ],
  { description: "When the job runs" },
);
const Settings = {
  sessionPolicy: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("continuing")], { description: "fresh (default): every run starts a new session. continuing: every run shares one session." })),
  catchUpWindowMs: Type.Optional(Type.Number({ description: "How late a recurring job's latest missed run may still start, in ms (default 2 hours)" })),
  notifyMode: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("when-needed"), Type.Literal("never")], { description: "When a finished run messages the user (default always). Failures and questions always do." })),
  trusted: Type.Optional(Type.Boolean({ description: "Let the job's runs make risky tool calls without asking first (default false). Only when the user asks for it." })),
};
const byName = Type.Object({ job: Type.String({ description: "The job's name (or id)" }) });

/** How long a confirmation waits before it counts as a no: the Manager's one session must not be held for the 12 hours an ordinary question may wait. */
export const CONFIRM_TIMEOUT_S = 30 * 60;
export const APPROVE = "Approve";
export const DENY = "Deny";

/** Show the user `body` and wait for their answer. True only for an explicit Approve; anything else is a no, with what they said. */
async function confirm(title: string, body: string, api: ToolExecutionApi, context: Context): Promise<{ approved: boolean; said: string; questionId: string }> {
  const result = await askAndWait({ question: `${title}\n\n${body}`, choices: [APPROVE, DENY], timeout: CONFIRM_TIMEOUT_S }, api, context);
  const said = (result.output ?? []).map((part) => ("text" in part ? part.text : "")).join("").trim();
  // The Scheduler checks that the user gave this answer, through their phone or pi, before it lets the change through.
  const questionId = String((result.details as { questionId?: unknown } | undefined)?.questionId ?? "");
  return { approved: !result.isError && said.toLowerCase() === APPROVE.toLowerCase(), said, questionId };
}

const NOT_DONE = (what: string, said: string) =>
  failure(`Not ${what}: ${said && said.toLowerCase() !== DENY.toLowerCase() && said !== NO_ANSWER ? `the user replied "${said}"` : "the user declined (or did not answer)"}. Ask what they would like changed.`);

/** Wrap a tool body so a Scheduler refusal comes back as the tool's error, in the Scheduler's own words. */
function guarded<A>(run: (args: A, api: ToolExecutionApi, context: Context) => Promise<ToolExecutionResult>) {
  return async (args: A, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> => {
    try {
      return await run(args, api, context);
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  };
}

export function createManager(options: { scheduler?: SchedulerApi } = {}) {
  const scheduler = options.scheduler ?? schedulerFromEnvironment();
  const jobs = async (): Promise<Job[]> => scheduler.request("GET", "/jobs");
  const jobPath = (id: string) => `/jobs/${encodeURIComponent(id)}`;

  // Reads can be repeated after a crash; everything that changes something is not (the default), so a crash
  // mid-call comes back as an interrupted result and never acts twice.
  const tools = [
    defineTool({
      name: "list_jobs",
      description: "List the user's scheduled jobs with their schedules and next run times.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: guarded(async () => {
        const all = await jobs();
        return text(all.length ? all.map(formatJobLine).join("\n") : "No jobs yet.", { jobs: all });
      }),
    }),
    defineTool({
      name: "create_job",
      description:
        "Create a scheduled job: a prompt that a Pi agent runs at one or more times. The user sees the job and its next run times and must approve before it is saved. For \"remind me at 5 to call the bank\" create a one-time job whose prompt says what to do, with an ISO time and offset.",
      parameters: Type.Object({
        name: Type.String({ description: "A short unique name" }),
        prompt: Type.String({ description: "What the agent should do each run, written so it makes sense with no other context" }),
        schedule: Schedule,
        model: Type.Optional(Type.String({ description: "provider/model. Default: the default model" })),
        workspace: Type.Optional(Type.String({ description: "The folder the runs work in. Default: the default workspace" })),
        ...Settings,
      }),
      execute: guarded(async (args, api, context) => {
        const preview = (await scheduler.request("POST", "/jobs?dryRun=true", args)) as Preview;
        const { approved, said, questionId } = await confirm("Save this job?", formatPreview(preview), api, context);
        if (!approved) return NOT_DONE("saved", said);
        const saved = (await scheduler.request("POST", "/jobs", args, questionId)) as Preview;
        return text(`Saved job "${saved.name}". Next runs: ${saved.nextFireTimes.join(", ") || "none"}.`, { job: saved });
      }),
    }),
    defineTool({
      name: "update_job",
      description: "Change a job's schedule, prompt or settings. The user sees the result and must approve before it is saved.",
      parameters: Type.Object({
        job: Type.String({ description: "The job's name (or id)" }),
        name: Type.Optional(Type.String()),
        prompt: Type.Optional(Type.String()),
        schedule: Type.Optional(Schedule),
        // Not a union with null (some providers handle `anyOf` with null poorly): an empty string clears the override.
        model: Type.Optional(Type.String({ description: "provider/model. An empty string removes the override (the default model is used)" })),
        workspace: Type.Optional(Type.String({ description: "The folder the runs work in. An empty string removes the override (the default workspace is used)" })),
        ...Settings,
      }),
      execute: guarded(async ({ job, ...given }, api, context) => {
        const patch = { ...given, ...(given.model === "" ? { model: null } : {}), ...(given.workspace === "" ? { workspace: null } : {}) };
        const found = findJob(await jobs(), job);
        const preview = (await scheduler.request("PATCH", `${jobPath(found.id)}?dryRun=true`, patch)) as Preview;
        const { approved, said, questionId } = await confirm(`Change "${found.name}" like this?`, formatPreview(preview), api, context);
        if (!approved) return NOT_DONE("changed", said);
        const saved = (await scheduler.request("PATCH", jobPath(found.id), patch, questionId)) as Preview;
        return text(`Updated "${saved.name}". Next runs: ${saved.nextFireTimes.join(", ") || "none"}.`, { job: saved });
      }),
    }),
    defineTool({
      name: "delete_job",
      description: "Delete a job. The user must approve; the run history is kept.",
      parameters: byName,
      execute: guarded(async ({ job }, api, context) => {
        const found = findJob(await jobs(), job);
        const { approved, said, questionId } = await confirm(`Delete "${found.name}"?`, `${formatJobLine(found)}\nPrompt: ${found.prompt}\n\nIts run history is kept.`, api, context);
        if (!approved) return NOT_DONE("deleted", said);
        await scheduler.request("DELETE", jobPath(found.id), undefined, questionId);
        return text(`Deleted "${found.name}".`);
      }),
    }),
    defineTool({
      name: "pause_job",
      description: "Pause a job: it stops firing until resumed and keeps its definition. A run already going is left alone. The user must approve.",
      parameters: byName,
      execute: guarded(async ({ job }, api, context) => {
        const found = findJob(await jobs(), job);
        if (found.status === "paused") return text(`"${found.name}" is already paused.`);
        if (found.status === "done") return text(`"${found.name}" has finished; there is nothing to pause.`);
        const { approved, said, questionId } = await confirm(`Pause "${found.name}"?`, `${formatJobLine(found)}\n\nIt stops firing until resumed. A run already going is left alone.`, api, context);
        if (!approved) return NOT_DONE("paused", said);
        await scheduler.request("POST", `${jobPath(found.id)}/pause`, undefined, questionId);
        return text(`Paused "${found.name}".`);
      }),
    }),
    defineTool({
      name: "resume_job",
      description: "Resume a paused job. It waits for its next occurrence: runs missed while it was paused are not made up. The user must approve.",
      parameters: byName,
      execute: guarded(async ({ job }, api, context) => {
        const found = findJob(await jobs(), job);
        if (found.status === "active") return text(`"${found.name}" is not paused.`);
        if (found.status === "done") return text(`"${found.name}" has finished; change its schedule to run it again.`);
        const { approved, said, questionId } = await confirm(`Resume "${found.name}"?`, `${formatJobLine(found)}\n\nIt waits for its next occurrence: nothing missed while it was paused is caught up.`, api, context);
        if (!approved) return NOT_DONE("resumed", said);
        const resumed = (await scheduler.request("POST", `${jobPath(found.id)}/resume`, undefined, questionId)) as Preview;
        return text(`Resumed "${found.name}". Next run: ${resumed.nextFireTimes?.[0] ?? "none"}.`);
      }),
    }),
    defineTool({
      name: "run_job_now",
      description: "Start a run of a job right now, without moving its schedule. The user must approve. Refused while its previous run is still active.",
      parameters: byName,
      execute: guarded(async ({ job }, api, context) => {
        const found = findJob(await jobs(), job);
        const { approved, said, questionId } = await confirm(`Run "${found.name}" now?`, `${formatJobLine(found)}\nPrompt: ${found.prompt}`, api, context);
        if (!approved) return NOT_DONE("started", said);
        const run = (await scheduler.request("POST", `${jobPath(found.id)}/run`, undefined, questionId)) as Run;
        return text(`Started a run of "${found.name}" (${run.id}).`, { run });
      }),
    }),
    defineTool({
      name: "stop_run",
      description: "Stop a job's active run. The user must approve.",
      parameters: byName,
      execute: guarded(async ({ job }, api, context) => {
        const found = findJob(await jobs(), job);
        const { approved, said, questionId } = await confirm(`Stop the active run of "${found.name}"?`, formatJobLine(found), api, context);
        if (!approved) return NOT_DONE("stopped", said);
        const run = (await scheduler.request("POST", `${jobPath(found.id)}/stop`, undefined, questionId)) as Run;
        return text(`Stopped the run of "${found.name}" (${run.status}).`, { run });
      }),
    }),
    defineTool({
      name: "reset_job",
      description: "Give a continuing job a fresh session; the old one is archived. The user must approve. Refused while a run is active.",
      parameters: byName,
      execute: guarded(async ({ job }, api, context) => {
        const found = findJob(await jobs(), job);
        const { approved, said, questionId } = await confirm(`Reset "${found.name}"?`, `${formatJobLine(found)}\n\nIts next run starts a new session; the old one is archived.`, api, context);
        if (!approved) return NOT_DONE("reset", said);
        await scheduler.request("POST", `${jobPath(found.id)}/reset`, undefined, questionId);
        return text(`Reset "${found.name}": its next run starts a new session.`);
      }),
    }),
    defineTool({
      name: "list_runs",
      description: "List runs, newest first, optionally only one job's.",
      parameters: Type.Object({ job: Type.Optional(Type.String({ description: "A job's name (or id) to list only its runs" })) }),
      replay: "safe",
      execute: guarded(async ({ job }) => {
        const all = await jobs();
        const only = job ? findJob(all, job) : undefined;
        const runs = (await scheduler.request("GET", only ? `/runs?jobId=${encodeURIComponent(only.id)}` : "/runs")) as Run[];
        const names = new Map(all.map((j) => [j.id, j.name]));
        return text(runs.length ? runs.slice(0, 25).map((r) => formatRunLine(r, names)).join("\n") : "No runs yet.", { runs });
      }),
    }),
    defineTool({
      name: "show_run",
      description: "Show one run: its status, times, session and summary.",
      parameters: Type.Object({ run: Type.String({ description: "The run's id, from list_runs" }) }),
      replay: "safe",
      execute: guarded(async ({ run }) => {
        const found = (await scheduler.request("GET", `/runs/${encodeURIComponent(run)}`)) as Run & { answer?: string; lastAction?: string };
        const lines = [`Run ${found.id}`, `Status: ${found.status}`, `Scheduled for: ${iso(found.scheduledAt)}`, `Started: ${iso(found.startedAt)}`, `Finished: ${iso(found.finishedAt)}`, `Summary: ${found.summary ?? "-"}`];
        if (found.answer) lines.push(`Answer: ${found.answer}`);
        if (found.lastAction) lines.push(`Last action: ${found.lastAction}`);
        return text(lines.join("\n"), { run: found });
      }),
    }),
    defineTool({
      name: "list_questions",
      description: "List the questions agents are waiting on, with the ids answer_question takes.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: guarded(async () => {
        const questions = (await scheduler.request("GET", "/questions?status=pending")) as Question[];
        return text(questions.length ? questions.map((q) => `${q.id}: ${q.question}${q.choices?.length ? ` [${q.choices.join(" / ")}]` : ""}`).join("\n") : "Nothing is waiting for the user.", { questions });
      }),
    }),
    defineTool({
      name: "telegram_status",
      description: "Say whether the user's Telegram bot is paired, and to which account. Read-only: pairing can only be changed by the user, outside the Manager.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: guarded(async () => {
        const state = (await scheduler.request("GET", "/telegram/pairing")) as { paired: boolean; userId?: number };
        return text(state.paired ? `Telegram is paired${state.userId !== undefined ? ` to account ${state.userId}` : ""}.` : "Telegram is not paired yet. The user pairs it themselves with the code in the Scheduler's log.", { telegram: state });
      }),
    }),
    defineTool({
      name: "answer_question",
      description: "Answer a question an agent is waiting on (see list_questions). The user sees the question and your answer and must approve; an approval is the user's decision, never yours.",
      parameters: Type.Object({
        question: Type.String({ description: "The question's id, from list_questions" }),
        answer: Type.String({ description: "The user's answer: one of the choices, or free text" }),
      }),
      execute: guarded(async ({ question, answer }, api, context) => {
        const pending = (await scheduler.request("GET", "/questions?status=pending")) as Question[];
        // The full id, then the Backend's id for it, then the start of either: the first kind of match that finds any decides, and it must be exactly one.
        const hits = [pending.filter((q) => q.id === question), pending.filter((q) => q.questionId === question), pending.filter((q) => q.id.startsWith(question))].find((tier) => tier.length > 0) ?? [];
        if (hits.length === 0) return failure(`no pending question "${question}"`);
        if (hits.length > 1) return failure(`"${question}" matches more than one question (${hits.map((q) => q.id).join("; ")}); use the full id`);
        const found = hits[0]!;
        const { approved, said, questionId } = await confirm("Send this answer?", `${found.question}${found.choices?.length ? `\nChoices: ${found.choices.join(" / ")}` : ""}\n\nAnswer: ${answer}`, api, context);
        if (!approved) return NOT_DONE("answered", said);
        await scheduler.request("POST", `/questions/${encodeURIComponent(found.id)}/answer`, { answer }, questionId);
        return text(`Answered "${found.question}" with "${answer}".`);
      }),
    }),
  ];

  const own = new Set(tools.map((t) => t.name));
  return defineExtension({
    name: MANAGER_EXTENSION,
    tools,
    // The Manager is untrusted and has the Scheduler's credential for its tools in reach: it gets these tools and nothing
    // else (no bash, no files, no state, no subagents), so it cannot read the Scheduler's or the Backend's credentials.
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call) => {
          if (own.has(call.name)) return;
          return { block: `The Manager can only use its job tools; "${call.name}" is not available to it.` };
        },
      }),
    ],
    sections: [section(MANAGER_EXTENSION, () => MANAGER_PROMPT, { tag: false })],
  });
}

/** The Manager's standing instructions. Constant on purpose: a prompt section must render the same every time. */
export const MANAGER_PROMPT = [
  "You are the user's job manager, talking to them through their phone. They schedule prompts for Pi agents (jobs) and you create, change, pause, resume, run, stop and delete them with your tools. Be brief.",
  'Each message starts with a line in square brackets giving the time it was sent and the user\'s timezone. Turn times like "at 5" into the next such moment in that timezone, written as an ISO time with its offset, or as a cron with that IANA timezone for something that repeats. Ask only if what they said is truly ambiguous.',
  'Infer settings from how they describe the job ("only ping me if it breaks" means notifyMode when-needed). Write each job\'s prompt so it makes sense with no other context.',
  "Creating, changing, deleting, pausing, resuming, running, stopping and resetting a job, and answering a question, show the user the details and wait for their Approve (it times out as a no after half an hour); never assume it. Leave trusted false unless they say the job should run unattended.",
].join("\n\n");
