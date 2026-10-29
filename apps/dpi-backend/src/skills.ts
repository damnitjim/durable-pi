// Shared skills: the same `SKILL.md` folders `pi` reads, advertised in every session's system prompt. pi-durable ships
// no skills extension, and pi's own loader lives in @earendil-works/pi-coding-agent (the whole CLI/TUI, ~25 MB), so this
// is a small port of its rules (core/skills.ts) with a mini YAML frontmatter reader in place of the `yaml` package.
//
//   skills section   name, description and path of each skill; the agent reads SKILL.md itself with `read`
//   /skill:name      a prompt starting with it is sent with that skill's instructions inlined
//
// Searched: ~/.agents/skills, then `.agents/skills` and `.pi/skills` from the workspace up to the repo root. Skipped:
// malformed skills and ones without a description. On a name collision the first one found wins, with a warning.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, section, type Extension } from "@earendil-works/pi-durable";

export type Skill = { name: string; description: string; path: string; dir: string; hidden: boolean };

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

// ------------------------------------------------------------------ frontmatter

/** The top-level keys of a `---` YAML block: scalars (plain, quoted, folded `>`, literal `|`) and booleans. Throws on anything else. */
export function parseFrontmatter(text: string): { data: Record<string, string | boolean>; body: string } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: {}, body: lines.join("\n") };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) throw Error("frontmatter is not closed");
  const data: Record<string, string | boolean> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#") || /^-(\s|$)/.test(line)) continue;
    const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!m) throw Error(`frontmatter line ${i + 1} is not "key: value": ${line.trim().slice(0, 60)}`);
    const [, key, rest = ""] = m;
    const indented: string[] = [];
    while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) indented.push(lines[++i]);
    const block = /^([>|])([+-]?)$/.exec(rest.trim());
    if (block) {
      const content = indented.map((l) => l.trim());
      while (content.length && !content.at(-1)) content.pop();
      data[key] = block[1] === ">" ? content.join(" ").replace(/\s+/g, " ").trim() : content.join("\n");
    } else if (!rest.trim()) {
      // A nested map or list (`metadata:`, `allowed-tools:`): nothing here reads it.
    } else data[key] = scalar([rest.trim(), ...indented.map((l) => l.trim())].join(" ").trim());
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

function scalar(raw: string): string | boolean {
  const quoted = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(raw) ?? /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(raw);
  if (quoted) return raw[0] === '"' ? quoted[1].replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c)) : quoted[1].replace(/''/g, "'");
  if (/^["']/.test(raw)) throw Error(`unterminated or trailing text after quoted value: ${raw.slice(0, 60)}`);
  if (/^[[{]/.test(raw)) {
    if (!/^(\[.*\]|\{.*\})(\s+#.*)?$/.test(raw)) throw Error(`unclosed flow collection: ${raw.slice(0, 60)}`);
    return raw;
  }
  const plain = raw.replace(/\s+#.*$/, "").trim();
  return plain === "true" ? true : plain === "false" ? false : plain;
}

// ------------------------------------------------------------------ discovery

/** Every directory that can hold skills for a workspace, in precedence order. */
function searchRoots(cwd: string, home: string) {
  const roots = [join(home, ".agents", "skills")];
  for (let dir = cwd; ; dir = dirname(dir)) {
    roots.push(join(dir, ".agents", "skills"), join(dir, ".pi", "skills"));
    if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
  }
  return roots;
}

/** `dir` is a skill if it holds a SKILL.md; otherwise each non-hidden subfolder is searched. Symlinks are followed. */
function walk(dir: string, found: Skill[], warn: (m: string) => void, visited = new Set<string>()) {
  try {
    const real = realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
  } catch {
    return;
  }
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const file = join(dir, "SKILL.md");
  if (entries.some((e) => e.name === "SKILL.md") && isFile(file)) return load(file, found, warn);
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const path = join(dir, e.name);
    if (e.isDirectory() || (e.isSymbolicLink() && isDirectory(path))) walk(path, found, warn, visited);
  }
}
const isFile = (p: string) => statOr(p)?.isFile() ?? false;
const isDirectory = (p: string) => statOr(p)?.isDirectory() ?? false;
function statOr(p: string) {
  try {
    return statSync(p);
  } catch {}
}

function load(path: string, found: Skill[], warn: (m: string) => void) {
  const dir = dirname(path);
  let data;
  try {
    data = parseFrontmatter(readFileSync(path, "utf8")).data;
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
export function discoverSkills(cwd: string, home: string, warn: (m: string) => void): Skill[] {
  const found: Skill[] = [];
  for (const root of searchRoots(cwd, home)) walk(root, found, warn);
  const byName = new Map<string, Skill>();
  const real = new Set<string>();
  for (const skill of found) {
    let id = skill.path;
    try {
      id = realpathSync(skill.path);
    } catch {}
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
function expand(text: string, skills: Skill[], warn: (m: string) => void) {
  const m = /^\/skill:(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const skill = m && skills.find((s) => s.name === m[1]);
  if (!m || !skill) return text;
  let body: string;
  try {
    body = parseFrontmatter(readFileSync(skill.path, "utf8")).body.trim();
  } catch (e) {
    warn(`/skill:${skill.name} could not read ${skill.path}: ${(e as Error).message}`);
    return text;
  }
  const block = `<skill name="${esc(skill.name)}" location="${esc(skill.path)}">\nReferences are relative to ${skill.dir}.\n\n${body}\n</skill>`;
  return m[2]?.trim() ? `${block}\n\n${m[2].trim()}` : block;
}

type Content = UserMessage["content"];
const textOf = (c: Content) => (typeof c === "string" ? c : c.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""));

/** `home` and `warn` are injectable so tests never read the real `~/.agents/skills`. */
export function createSkills(opts: { home?: string; warn?: (message: string) => void } = {}): Extension {
  const home = opts.home ?? homedir();
  const out = opts.warn ?? ((m: string) => console.error(`[skills] ${m}`));
  // Discovery runs on every request, so say each thing once.
  const said = new Set<string>();
  const warn = (m: string) => said.has(m) || (said.add(m), out(m), true);
  // What each conversation's last section render found, so /skill:name expands against the list the model was shown.
  const seen = new Map<string, Skill[]>();
  return defineExtension({
    name: "skills",
    sections: [
      section(
        "skills",
        (input) => {
          const skills = discoverSkills(input.agent.cwd ?? process.cwd(), home, warn);
          seen.set(String(input.conversationId), skills);
          return render(skills);
        },
        { tag: false },
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }, api) => {
          const skills = seen.get(String(api.conversationId));
          if (!skills?.length) return;
          let changed = false;
          const next = messages.map((m) => {
            if (m.role !== "user") return m;
            const content: Content = m.content;
            const was = textOf(content);
            const now = expand(was, skills, warn);
            if (now === was) return m;
            changed = true;
            // Keep any image blocks; the expanded text replaces the text ones.
            const rest = typeof content === "string" ? [] : content.filter((b) => b.type !== "text");
            return { ...m, content: rest.length ? [{ type: "text" as const, text: now }, ...rest] : now };
          });
          return changed ? { messages: next } : undefined;
        },
      }),
    ],
  });
}
