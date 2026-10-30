import { test } from "node:test";
import assert from "node:assert/strict";
import { findJob, formatPreview } from "../src/scheduler-reading.js";
import type { Job, Preview } from "../src/scheduler-shapes.js";

const job = (id: string, name: string): Job => ({
  id,
  name,
  prompt: "p",
  schedule: { kind: "cron", expr: "0 8 * * *", timezone: "America/Chicago" },
  status: "active",
  nextFireAt: 1,
  sessionPolicy: "fresh",
  model: null,
  workspace: null,
  notifyMode: "always",
  trusted: false,
  catchUpWindowMs: 7_200_000,
});

test("findJob matches an id, then the exact name, then the name with spaces squeezed, then in any case", () => {
  const jobs = [job("a1", "Daily  Digest"), job("b2", "weekly report")];
  assert.equal(findJob(jobs, "a1").id, "a1");
  assert.equal(findJob(jobs, "Daily  Digest").id, "a1");
  assert.equal(findJob(jobs, "Daily Digest").id, "a1", "a name made with two spaces can be typed with one");
  assert.equal(findJob(jobs, " DAILY   digest ").id, "a1");
  assert.equal(findJob(jobs, "Weekly Report").id, "b2");
});

test("findJob refuses an unknown or ambiguous name, saying why", () => {
  const jobs = [job("a1", "Digest"), job("b2", "digest")];
  assert.equal(findJob(jobs, "digest").id, "b2", "the exact name wins over the looser tiers");
  assert.throws(() => findJob(jobs, "DIGEST"), /matches more than one job/);
  assert.throws(() => findJob(jobs, "nope"), /no job called "nope" \(jobs: Digest, digest\)/);
  assert.throws(() => findJob([], "nope"), /there are no jobs yet/);
});

test("formatPreview shows everything the user is agreeing to", () => {
  const text = formatPreview({ ...job("a1", "Digest"), trusted: true, nextFireTimes: ["2026-10-30T13:00:00Z"] } as Preview);
  assert.match(text, /^Name: Digest\nSchedule: cron "0 8 \* \* \*" \(America\/Chicago\)\nNext runs: 2026-10-30T13:00:00Z\n/);
  assert.match(text, /Trusted: YES/);
  assert.match(text, /Catch-up window: 120 min$/);
});
