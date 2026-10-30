// Shared skills: the same `SKILL.md` folders `pi` reads, advertised in every session's system prompt. pi-durable ships
// no skills extension, and pi's own loader lives in @earendil-works/pi-coding-agent (the whole CLI/TUI, ~25 MB), so this
// is a small port of its rules (core/skills.ts) with a mini YAML frontmatter reader in place of the `yaml` package.
//
//   skills section   name, description and path of each skill; the agent reads SKILL.md itself with `read`
//   /skill:name      a prompt starting with it is sent with that skill's instructions inlined
//
// Searched: ~/.agents/skills, then `.agents/skills` and `.pi/skills` from the workspace up to the repo root (or the
// filesystem root, with no `.git` on the way). Skipped: malformed skills and ones without a description. On a name
// collision the first one found wins, with a warning.
//
// Discovery reads the folders asynchronously and is remembered per workspace for a few seconds, so a burst of requests
// walks them once and a new skill shows up within that time. Warnings go to the service log (`~/.dpi/backend.log`, each
// said once), where the person who installed the skill looks when it does not appear.
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { UserMessage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, section, type Extension } from "@earendil-works/pi-durable";

export type Skill = { name: string; description: string; path: string; dir: string; hidden: boolean };

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

// ------------------------------------------------------------------ frontmatter

/** The `---` YAML block at the top of a file, parsed by the yaml package like pi does. Throws on malformed YAML. */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: {}, body: lines.join("\n") };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) throw Error("frontmatter is not closed");
  const parsed = parseYaml(lines.slice(1, end).join("\n"));
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return { data, body: lines.slice(end + 1).join("\n") };
}

// ------------------------------------------------------------------ discovery

const exists = (p: string) => access(p).then(() => true, () => false);

/** Every directory that can hold skills for a workspace, in precedence order. */
async function searchRoots(cwd: string, home: string) {
  const roots = [join(home, ".agents", "skills")];
  for (let dir = cwd; ; dir = dirname(dir)) {
    roots.push(join(dir, ".agents", "skills"), join(dir, ".pi", "skills"));
    if ((await exists(join(dir, ".git"))) || dirname(dir) === dir) break;
  }
  return roots;
}

/** `dir` is a skill if it holds a SKILL.md; otherwise each non-hidden subfolder is searched. Symlinks are followed. */
async function walk(dir: string, found: Skill[], warn: (m: string) => void, visited = new Set<string>()): Promise<void> {
  try {
    const real = await realpath(dir);
    if (visited.has(real)) return;
    visited.add(real);
  } catch {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const file = join(dir, "SKILL.md");
  if (entries.some((e) => e.name === "SKILL.md") && (await isFile(file))) return load(file, found, warn);
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const path = join(dir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && (await isDirectory(path)))) await walk(path, found, warn, visited);
  }
}
const isFile = async (p: string) => (await statOr(p))?.isFile() ?? false;
const isDirectory = async (p: string) => (await statOr(p))?.isDirectory() ?? false;
const statOr = (p: string) => stat(p).catch(() => undefined);

async function load(path: string, found: Skill[], warn: (m: string) => void) {
  const dir = dirname(path);
  let data;
  try {
    data = parseFrontmatter(await readFile(path, "utf8")).data;
  } catch (e) {
    return warn(`skipped ${path}: ${(e as Error).message}`);
  }
  const description = typeof data.description === "string" ? data.description : "";
  if (!description.trim()) return warn(`skipped ${path}: description is required`);
  if (description.length > MAX_DESCRIPTION) warn(`${path}: description exceeds ${MAX_DESCRIPTION} characters (${description.length})`);
  const name = typeof data.name === "string" && data.name ? data.name : basename(dir);
  if (name.length > MAX_NAME) warn(`${path}: name exceeds ${MAX_NAME} characters (${name.length})`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) warn(`${path}: name "${name}" should be lowercase a-z, 0-9 and single hyphens`);
  found.push({ name, description, path, dir, hidden: data["disable-model-invocation"] === true });
}

/** All skills visible from `cwd`: first found wins by name, and a repeat of the same file is ignored silently. */
export async function discoverSkills(cwd: string, home: string, warn: (m: string) => void): Promise<Skill[]> {
  const found: Skill[] = [];
  for (const root of await searchRoots(cwd, home)) await walk(root, found, warn);
  const byName = new Map<string, Skill>();
  const real = new Set<string>();
  for (const skill of found) {
    const id = await realpath(skill.path).catch(() => skill.path);
    if (real.has(id)) continue;
    real.add(id);
    const winner = byName.get(skill.name);
    if (winner) warn(`skill "${skill.name}" at ${skill.path} ignored: ${winner.path} was found first`);
    else byName.set(skill.name, skill);
  }
  return [...byName.values()];
}

// ------------------------------------------------------------------ prompt

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function render(skills: Skill[]) {
  const listed = skills.filter((s) => !s.hidden);
  if (!listed.length) return undefined;
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...listed.flatMap((s) => [
      "  <skill>",
      `    <name>${esc(s.name)}</name>`,
      `    <description>${esc(s.description)}</description>`,
      `    <location>${esc(s.path)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

/** `/skill:name args` → the skill's instructions, then the args. Anything else (or an unknown name) is left alone. */
async function expand(text: string, skills: Skill[], warn: (m: string) => void) {
  const m = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const skill = m && skills.find((s) => s.name === m[1]);
  if (!m || !skill) return text;
  let body: string;
  try {
    body = parseFrontmatter(await readFile(skill.path, "utf8")).body.trim();
  } catch (e) {
    warn(`/skill:${skill.name} could not read ${skill.path}: ${(e as Error).message}`);
    return text;
  }
  const block = `<skill name="${esc(skill.name)}" location="${esc(skill.path)}">\nReferences are relative to ${skill.dir}.\n\n${body}\n</skill>`;
  return m[2]?.trim() ? `${block}\n\n${m[2].trim()}` : block;
}

type Content = UserMessage["content"];
const textOf = (c: Content) => (typeof c === "string" ? c : c.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""));

/** How long what a workspace's folders held is believed. */
const CACHE_MS = 5_000;

/** `home`, `warn`, the cache's lifetime and the clock are injectable so tests never read the real `~/.agents/skills`, and never wait. */
export function createSkills(opts: { home?: string; warn?: (message: string) => void; cacheMs?: number; now?: () => number } = {}): Extension {
  const home = opts.home ?? homedir();
  const cacheMs = opts.cacheMs ?? CACHE_MS;
  const now = opts.now ?? Date.now;
  const out = opts.warn ?? ((m: string) => console.error(`[skills] ${m}`));
  // Discovery runs on every request, so say each thing once.
  const said = new Set<string>();
  const warn = (m: string) => said.has(m) || (said.add(m), out(m), true);
  // What each conversation's last section render found, so /skill:name expands against the list the model was shown.
  const seen = new Map<string, Skill[]>();
  // One discovery per workspace at a time, believed for `cacheMs`; requests that arrive meanwhile share it.
  const cache = new Map<string, { at: number; skills: Promise<Skill[]> }>();
  const skillsFor = (cwd: string) => {
    const cached = cache.get(cwd);
    if (cached && now() - cached.at < cacheMs) return cached.skills;
    const skills = discoverSkills(cwd, home, warn);
    cache.set(cwd, { at: now(), skills });
    return skills;
  };
  return defineExtension({
    name: "skills",
    sections: [
      section(
        "skills",
        async (input) => {
          const skills = await skillsFor(input.agent.cwd ?? process.cwd());
          seen.set(String(input.conversationId), skills);
          return render(skills);
        },
        { tag: false },
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          const skills = seen.get(String(api.conversationId));
          if (!skills?.length) return;
          let changed = false;
          const next = [];
          for (const m of messages) {
            if (m.role !== "user") {
              next.push(m);
              continue;
            }
            const content: Content = m.content;
            const was = textOf(content);
            const expanded = await expand(was, skills, warn);
            if (expanded === was) {
              next.push(m);
              continue;
            }
            changed = true;
            // Keep any image blocks; the expanded text replaces the text ones.
            const rest = typeof content === "string" ? [] : content.filter((b) => b.type !== "text");
            next.push({ ...m, content: rest.length ? [{ type: "text" as const, text: expanded }, ...rest] : expanded });
          }
          return changed ? { messages: next } : undefined;
        },
      }),
    ],
  });
}
