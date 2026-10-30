// What the Scheduler (damnitjim/durable-jim-agent) returns for jobs, runs and questions, as far as the Manager's tools
// read it. Types only, with no imports, so the Scheduler's repo can check its own types against this file: its
// `pnpm smoke` fails if a field the Manager reads is renamed, removed or made less certain there. When the Scheduler
// changes one of these on purpose, change it here in the same breath.

export type Job = {
  id: string;
  name: string;
  prompt: string;
  schedule: { kind: "once"; at: string } | { kind: "cron"; expr: string; timezone: string };
  status: string;
  nextFireAt: number | null;
  sessionPolicy: string;
  model: string | null;
  workspace: string | null;
  notifyMode: string;
  trusted: boolean;
  catchUpWindowMs: number;
  maxRunMs: number;
};
export type Preview = Job & { nextFireTimes: string[] };
export type Run = { id: string; jobId: string; scheduledAt: number; status: string; summary: string | null; startedAt: number; finishedAt: number | null; sessionId: string | null };
export type Question = { id: string; questionId: string; jobId: string | null; question: string; choices?: string[]; askedAt: number; timeoutAt: number };
