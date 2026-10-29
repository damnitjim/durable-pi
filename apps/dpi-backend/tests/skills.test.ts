import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createSkills, parseFrontmatter } from "../src/skills.js";

type Msg = { role: string; content?: unknown };
const textOf = (m?: Msg) =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
      ? (m!.content as { type: string; text?: string }[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("")
      : "";

/** A real pi-durable harness on temporary SQLite with the skills extension; only the model is scripted. */
async function rig() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dpi-skills-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const work = join(repo, "packages", "app");
  await mkdir(home, { recursive: true });
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(work, { recursive: true });
  const warnings: string[] = [];
  const models = createModels();
  const handle = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: 128000, maxTokens: 8192 }] });
  models.setProvider(handle.provider);
  let requests: Msg[][] = [];
  // "read: <path>" makes the model call the read tool on it; every other prompt, and every tool result, gets "ok".
  const reply: FauxResponseFactory = (context) => {
    handle.appendResponses([reply]);
    const messages = context.messages as unknown as Msg[];
    requests.push([...messages]);
    const last = messages.at(-1);
    if (last?.role !== "toolResult" && textOf(last).startsWith("read: "))
      return fauxAssistantMessage([fauxToolCall("read", { path: textOf(last).slice(6) })], { stopReason: "toolUse" });
    return fauxAssistantMessage(fauxText("ok"));
  };
  handle.setResponses([reply]);
  const registry = createRegistry();
  registry.install(CodingTools);
  const skills = createSkills({ home, warn: (m) => warnings.push(m) });
  registry.install(skills);
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(root, "s.sqlite")),
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? work }),
      settings: { extensions: [CodingTools, skills] },
    },
    ctx,
  );
  const conversation = await harness.root(ctx, { agent: { cwd: work, model: { provider: "faux", modelId: "m" } } });
  return {
    root,
    home,
    repo,
    work,
    warnings,
    handle,
    /** Write a file under the temp tree, creating folders. */
    async put(path: string, text: string) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },
    /** Send one prompt and return what the model was shown for the first request it caused. */
    async ask(prompt: string) {
      requests = [];
      const done = await (await conversation.submit({ type: "input", content: prompt }, ctx)).wait(ctx);
      assert.equal(done.status, "done");
      const messages = requests[0]!;
      return {
        system: messages.filter((m) => m.role === "system").map((m) => Object.values((m as Msg & { sections?: Record<string, string> }).sections ?? {}).join("\n")).join("\n"),
        user: textOf([...messages].reverse().find((m) => m.role === "user")),
        requests,
      };
    },
    async cleanup() {
      await harness.close(ctx);
      await rm(root, { recursive: true, force: true });
    },
  };
}

const skillMd = (name: string, description: string, body = "Do the thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

test("the skills section lists name, description and path of skills from home, and from the workspace up to the repo root", async () => {
  const t = await rig();
  try {
    await t.put(join(t.home, ".agents/skills/home-skill/SKILL.md"), skillMd("home-skill", "From home."));
    await t.put(join(t.work, ".agents/skills/near/SKILL.md"), skillMd("near", "Workspace agents skill."));
    await t.put(join(t.work, ".pi/skills/pi-near/SKILL.md"), skillMd("pi-near", "Workspace pi skill."));
    await t.put(join(t.repo, ".agents/skills/root/SKILL.md"), skillMd("root", "Repo root skill."));
    await t.put(join(t.root, ".agents/skills/above/SKILL.md"), skillMd("above", "Above the repo root."));
    await t.put(join(t.home, ".pi/skills/pi-home/SKILL.md"), skillMd("pi-home", "Not a searched home folder."));
    const { system } = await t.ask("hi");
    for (const [name, description, where] of [
      ["home-skill", "From home.", join(t.home, ".agents/skills/home-skill/SKILL.md")],
      ["near", "Workspace agents skill.", join(t.work, ".agents/skills/near/SKILL.md")],
      ["pi-near", "Workspace pi skill.", join(t.work, ".pi/skills/pi-near/SKILL.md")],
      ["root", "Repo root skill.", join(t.repo, ".agents/skills/root/SKILL.md")],
    ])
      for (const part of [name, description, where]) assert.ok(system.includes(part), `section should include ${part}`);
    assert.ok(!system.includes("Above the repo root."), "the walk stops at the repo root");
    assert.ok(!system.includes("pi-home"), "only ~/.agents/skills is read under home");
  } finally {
    await t.cleanup();
  }
});

test("skills are found recursively, through symlinks, and a SKILL.md folder is not searched further", async () => {
  const t = await rig();
  try {
    const base = join(t.home, ".agents/skills");
    await t.put(join(base, "group/deep/SKILL.md"), skillMd("deep", "Nested two folders down."));
    await t.put(join(base, "outer/SKILL.md"), skillMd("outer", "A skill folder."));
    await t.put(join(base, "outer/inner/SKILL.md"), skillMd("inner", "Inside a skill folder."));
    await t.put(join(base, ".hidden/SKILL.md"), skillMd("hidden", "In a dot folder."));
    await t.put(join(base, "node_modules/pkg/SKILL.md"), skillMd("pkg", "In node_modules."));
    await t.put(join(t.root, "elsewhere/linked/SKILL.md"), skillMd("linked", "Reached through a symlink."));
    await symlink(join(t.root, "elsewhere/linked"), join(base, "link"));
    const { system } = await t.ask("hi");
    assert.ok(system.includes("Nested two folders down."));
    assert.ok(system.includes("A skill folder."));
    assert.ok(system.includes("Reached through a symlink."));
    for (const gone of ["Inside a skill folder.", "In a dot folder.", "In node_modules."])
      assert.ok(!system.includes(gone), `should skip: ${gone}`);
  } finally {
    await t.cleanup();
  }
});

test("pi's rules: YAML frontmatter, skip malformed or description-less skills, name falls back to the folder", async () => {
  const t = await rig();
  try {
    const base = join(t.home, ".agents/skills");
    await t.put(join(base, "folded/SKILL.md"), `---\nname: folded\ndescription: >\n  First line\n  second line.\nlicense: MIT\n---\nBody\n`);
    await t.put(join(base, "quoted/SKILL.md"), `---\nname: "quoted"\ndescription: 'It''s: quoted # not a comment'\n---\nBody\n`);
    await t.put(join(base, "no-name/SKILL.md"), `---\ndescription: Named by its folder.\n---\nBody\n`);
    await t.put(join(base, "no-description/SKILL.md"), `---\nname: no-description\n---\nBody\n`);
    await t.put(join(base, "blank-description/SKILL.md"), `---\nname: blank-description\ndescription: "  "\n---\nBody\n`);
    await t.put(join(base, "no-frontmatter/SKILL.md"), `Just text, no frontmatter.\n`);
    await t.put(join(base, "malformed/SKILL.md"), `---\nname: malformed\ndescription: [unclosed\nthis line is not yaml\n---\nBody\n`);
    await t.put(join(base, "Bad_Name/SKILL.md"), `---\nname: Bad_Name\ndescription: Name breaks the rules but still loads.\n---\nBody\n`);
    await t.put(join(base, "hidden/SKILL.md"), `---\nname: hidden\ndescription: Only by command.\ndisable-model-invocation: true\n---\nBody\n`);
    const { system } = await t.ask("hi");
    assert.ok(system.includes("First line second line."));
    assert.ok(system.includes("It's: quoted # not a comment"));
    assert.ok(system.includes("no-name") && system.includes("Named by its folder."));
    assert.ok(system.includes("Bad_Name") && system.includes("still loads"));
    for (const gone of ["no-description", "blank-description", "no-frontmatter", "malformed", "Only by command."])
      assert.ok(!system.includes(gone), `should skip: ${gone}`);
    assert.ok(t.warnings.some((w) => w.includes("malformed")), "a malformed skill is reported");
  } finally {
    await t.cleanup();
  }
});

test("on a name collision the first skill found wins, with a warning naming both paths", async () => {
  const t = await rig();
  try {
    const home = join(t.home, ".agents/skills/dup/SKILL.md");
    const work = join(t.work, ".agents/skills/dup/SKILL.md");
    await t.put(home, skillMd("dup", "The home one."));
    await t.put(work, skillMd("dup", "The workspace one."));
    const { system } = await t.ask("hi");
    assert.ok(system.includes("The home one."));
    assert.ok(!system.includes("The workspace one."));
    const warning = t.warnings.find((w) => w.includes("dup"));
    assert.ok(warning?.includes(home) && warning.includes(work), `warning should name both paths: ${warning}`);
  } finally {
    await t.cleanup();
  }
});

test("no skills: the section is omitted", async () => {
  const t = await rig();
  try {
    const { system } = await t.ask("hi");
    assert.ok(!system.includes("available_skills"));
  } finally {
    await t.cleanup();
  }
});

test("/skill:name forces that skill, with the arguments after it", async () => {
  const t = await rig();
  try {
    await t.put(join(t.home, ".agents/skills/greet/SKILL.md"), skillMd("greet", "Greets.", "Say HELLO-FROM-SKILL loudly."));
    await t.put(join(t.home, ".agents/skills/quiet/SKILL.md"), `---\nname: quiet\ndescription: Command only.\ndisable-model-invocation: true\n---\nWhisper QUIET-BODY.\n`);
    const forced = await t.ask("/skill:greet to the whole team");
    assert.ok(forced.user.includes("Say HELLO-FROM-SKILL loudly."));
    assert.ok(forced.user.includes(join(t.home, ".agents/skills/greet")), "the skill's folder is given for relative paths");
    assert.ok(forced.user.trim().endsWith("to the whole team"));
    assert.ok(!forced.user.includes("description: Greets."), "frontmatter is not repeated");
    const hidden = await t.ask("/skill:quiet");
    assert.ok(hidden.user.includes("Whisper QUIET-BODY."), "a command-only skill still works by command");
    const unknown = await t.ask("/skill:nope do it");
    assert.equal(unknown.user, "/skill:nope do it");
    const mid = await t.ask("please run /skill:greet");
    assert.equal(mid.user, "please run /skill:greet");
  } finally {
    await t.cleanup();
  }
});

test("the harness environment reads a skill folder outside the workspace", async () => {
  const t = await rig();
  try {
    const path = join(t.home, ".agents/skills/outside/SKILL.md");
    await t.put(path, skillMd("outside", "Lives under home.", "OUTSIDE-BODY"));
    const { requests } = await t.ask(`read: ${path}`);
    const result = requests[1]!.findLast((m) => m.role === "toolResult");
    assert.ok(textOf(result).includes("OUTSIDE-BODY"), `the read tool should return the file: ${textOf(result)}`);
  } finally {
    await t.cleanup();
  }
});

test("frontmatter is real YAML: multi-line flow lists, block scalars with chomping, quoted keys, comments", () => {
  const { data, body } = parseFrontmatter(
    [
      "---",
      "# a comment",
      "name: review-pr",
      'description: >-',
      "  Reviews a pull request",
      "  and reports findings.",
      "allowed-tools: [read,",
      "  bash]",
      '"disable-model-invocation": true',
      "---",
      "# Body",
    ].join("\n"),
  );
  assert.equal(data.name, "review-pr");
  assert.equal(data.description, "Reviews a pull request and reports findings.");
  assert.deepEqual(data["allowed-tools"], ["read", "bash"]);
  assert.equal(data["disable-model-invocation"], true);
  assert.equal(body, "# Body");
  assert.throws(() => parseFrontmatter("---\nname: [unclosed\n---\n"));
});
