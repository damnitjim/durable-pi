// How the Manager reads the Scheduler's jobs: which job a name means, and how a job is shown for approval. Kept free of
// imports beyond the shapes so the Scheduler's repo can run these against its own (`pnpm smoke`); where it has a rule
// of its own for the same thing (`resolveJob`, the pi package's `formatPreview`) the two must give the same answers.
import type { Job, Preview } from "./scheduler-shapes.js";

export const describeSchedule = (j: Pick<Job, "schedule">) => (j.schedule.kind === "once" ? `once at ${j.schedule.at}` : `cron "${j.schedule.expr}" (${j.schedule.timezone})`);

/** The whole job, for a confirmation: everything the user is agreeing to. */
export function formatPreview(job: Preview): string {
  return [
    `Name: ${job.name}`,
    `Schedule: ${describeSchedule(job)}`,
    `Next runs: ${job.nextFireTimes.length ? job.nextFireTimes.join(", ") : "none"}`,
    `Prompt: ${job.prompt}`,
    `Session: ${job.sessionPolicy === "continuing" ? "continuing (every run shares one session)" : "fresh (every run starts clean)"}`,
    `Model: ${job.model ?? "pi's default"}`,
    `Workspace: ${job.workspace ?? "the default workspace"}`,
    `Notify: ${job.notifyMode}`,
    `Trusted: ${job.trusted ? "YES, risky tool calls will not ask first" : "no"}`,
    `Catch-up window: ${Math.round(job.catchUpWindowMs / 60_000)} min`,
  ].join("\n");
}

/**
 * A job by id, exact name, name with runs of spaces squeezed, or that in any case; the first kind of match that finds
 * anything decides, and it must find exactly one. The same rule as the Scheduler's own (`resolveJob`), kept in step by
 * its repo's `pnpm smoke`.
 */
export function findJob(jobs: Job[], nameOrId: string): Job {
  const wanted = nameOrId.trim();
  // A chat client and the model both squeeze runs of spaces, so a name made with two could never be typed otherwise.
  const squeeze = (text: string) => text.trim().replace(/\s+/g, " ");
  const tiers = [
    jobs.filter((j) => j.id === wanted),
    jobs.filter((j) => j.name === wanted),
    jobs.filter((j) => squeeze(j.name) === squeeze(wanted)),
    jobs.filter((j) => squeeze(j.name).toLowerCase() === squeeze(wanted).toLowerCase()),
  ];
  const hits = tiers.find((tier) => tier.length > 0);
  if (!hits) throw new Error(`no job called "${nameOrId}"${jobs.length ? ` (jobs: ${jobs.map((j) => j.name).join(", ")})` : " (there are no jobs yet)"}`);
  if (hits.length > 1) throw new Error(`"${nameOrId}" matches more than one job (${hits.map((j) => `${j.name}: ${j.id}`).join("; ")}); use the id`);
  return hits[0]!;
}
