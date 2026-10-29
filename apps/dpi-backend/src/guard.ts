// The guard: what an unattended run may do. Installed in every session, the Manager's included, and enforced here
// rather than in the prompt, so a misled agent can't talk its way around it.
//
//   write, edit   only inside the session's workspace (always, trusted jobs too)
//   bash          a call that matches the risk list does not run; it becomes an `ask_user` approval and runs only if
//                 the answer is "Approve". Trusted jobs skip the approval.
//
// The risk list is built in, and the global guard file overrides it: a command matching an `ask` pattern is always
// asked about, one matching an `allow` pattern (and no `ask` pattern) never is. Patterns are regular expressions
// tested against the whole command. Bash analysis is best effort; it reads the command, it doesn't run a shell.
//
// The checks are tool wraps, not `beforeTool` hooks: a hook has no agent (so no workspace) and can't commit (so can't
// ask), and a wrap also covers calls tools make through `executeTool()`.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { defineExtension, wrapTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { askAndWait, AttentionDoc } from "./ask-user.js";

export type GuardRules = { allow: RegExp[]; ask: RegExp[] };

// ------------------------------------------------------------------ the guard file

/** `{ "allow": [...], "ask": [...] }`, read on every call so an edit applies at once. A broken file means no rules. */
export function readRules(file: string, warn: (message: string) => void): GuardRules {
  const rules: GuardRules = { allow: [], ask: [] };
  if (!existsSync(file)) return rules;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const key of ["allow", "ask"] as const) {
      const list = parsed[key] ?? [];
      if (!Array.isArray(list) || list.some((p) => typeof p !== "string")) throw Error(`"${key}" must be a list of patterns`);
      rules[key] = (list as string[]).map((p) => new RegExp(p));
    }
    return rules;
  } catch (e) {
    warn(`ignoring ${file}: ${(e as Error).message}`);
    return { allow: [], ask: [] };
  }
}

// ------------------------------------------------------------------ paths

/** `~` and `$HOME` expanded. Undefined when the path leans on some other variable or substitution we can't see through. */
function expandPath(raw: string, home: string): string | undefined {
  const text = raw.replace(/^(\$HOME|\$\{HOME\}|~)(?=\/|$)/, home);
  return /[$`]/.test(text) ? undefined : text;
}

/** The real path of `path` or, if it doesn't exist yet, of its nearest existing ancestor plus the rest. */
function realish(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(current);
      return join(realpathSync(current), ...rest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) throw e;
      rest.unshift(basename(current));
      current = dirname(current);
    }
  }
}

function inside(workspace: string, path: string): boolean {
  const rel = relative(workspace, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether `raw` (as written in a call run from `cwd`) lands inside the workspace. Anything unclear counts as outside. */
function withinWorkspace(workspace: string, raw: string, home: string, from = workspace): boolean {
  const expanded = expandPath(raw, home);
  if (expanded === undefined) return false;
  try {
    return inside(realpathSync(workspace), realish(resolve(from, expanded)));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ the built-in risk list

const SHELL_SPLIT = /&&|\|\||[;|&\n()`]|\$\(/;
const WRAPPERS = new Set(["env", "command", "nohup", "time", "exec", "nice", "builtin", "timeout", "xargs"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const unquote = (token: string) => token.replace(/^["']|["']$/g, "");

type Segment = { word: string; args: string[]; text: string };

function segments(command: string): Segment[] {
  return command
    .split(SHELL_SPLIT)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => {
      const tokens = text.split(/\s+/).map(unquote);
      // Drop wrappers with their flags and numeric arguments (`nice -n 5`, `timeout 5`), and a leading backslash.
      for (;;) {
        tokens[0] = tokens[0]?.replace(/^\\/, "");
        if (tokens.length && /^\w+=/.test(tokens[0])) tokens.shift();
        else if (tokens.length && WRAPPERS.has(tokens[0])) {
          tokens.shift();
          while (tokens.length && (tokens[0].startsWith("-") || /^\d+[smhd]?$/.test(tokens[0]))) tokens.shift();
        } else break;
      }
      return { word: basename(tokens[0] ?? ""), args: tokens.slice(1), text };
    });
}

const flagsOf = (args: string[]) => args.filter((a) => a.startsWith("-"));
const hasShort = (args: string[], letters: string) =>
  flagsOf(args).some((a) => !a.startsWith("--") && [...letters].some((l) => a.includes(l)));
const hasLong = (args: string[], ...names: string[]) =>
  flagsOf(args).some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));

const INSTALLERS: Record<string, string[]> = {
  npm: ["install", "i", "add", "ci"],
  pnpm: ["install", "i", "add"],
  yarn: ["install", "add"],
  bun: ["install", "i", "add"],
  pip: ["install"],
  pip3: ["install"],
  pipx: ["install"],
  uv: ["add", "sync", "install"],
  brew: ["install", "reinstall", "upgrade"],
  gem: ["install"],
  cargo: ["install"],
  go: ["install", "get"],
  composer: ["install", "require"],
  apt: ["install"],
  "apt-get": ["install"],
  yum: ["install"],
  dnf: ["install"],
};
const WRITERS = new Set(["tee", "cp", "mv", "ln", "install", "touch", "sed", "perl", "chmod", "chown", "dd", "rsync", "truncate"]);
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred"]);

/** Why a command needs approval, or undefined if it doesn't. */
export function defaultRisk(command: string, startCwd: string, home: string): string | undefined {
  let cwd = startCwd;
  for (const { word, args, text } of segments(command)) {
    // `bash -c "…"`, `eval …` and `find -exec …` run more commands; read them as if they were written here.
    if (SHELLS.has(word) && args.includes("-c")) {
      const inner = defaultRisk(args.slice(args.indexOf("-c") + 1).join(" "), cwd, home);
      if (inner) return inner;
    }
    if (word === "eval") {
      const inner = defaultRisk(args.join(" "), cwd, home);
      if (inner) return inner;
    }
    if (word === "find" && args.some((a) => a === "-exec" || a === "-execdir" || a === "-delete")) {
      const at = args.findIndex((a) => a === "-exec" || a === "-execdir");
      const inner = at >= 0 ? defaultRisk(args.slice(at + 1).join(" "), cwd, home) : undefined;
      if (inner) return inner;
      if (args.includes("-delete") && !withinWorkspace(startCwd, args.find((a) => !a.startsWith("-")) ?? ".", home, cwd))
        return "deletes outside the workspace";
    }
    // Later segments of `cd X && …` run from X.
    if (word === "cd" && args[0]) {
      const target = expandPath(args[0], home);
      cwd = target === undefined ? "/" : resolve(cwd, target);
      continue;
    }
    if (word === "sudo" || word === "doas" || word === "su") return "runs as another user (sudo)";
    if (word === "launchctl") return "changes launchd services (launchctl)";
    if (word === "osascript") return "scripts other apps (osascript)";

    if (DELETERS.has(word)) {
      if (word === "rm" && (hasLong(args, "--recursive") || hasShort(args, "rR")) && (hasLong(args, "--force") || hasShort(args, "f")))
        return "force-deletes recursively (rm -rf)";
      const targets = args.filter((a) => !a.startsWith("-"));
      if (targets.some((t) => !withinWorkspace(startCwd, t, home, cwd))) return "deletes outside the workspace";
    }

    if (word === "git") {
      const rest = [...args];
      while (rest[0]?.startsWith("-")) {
        const flag = rest.shift();
        if (flag === "-C" || flag === "-c") rest.shift();
      }
      const sub = rest[0];
      const tail = rest.slice(1);
      if (sub === "push") return "pushes to a remote (git push)";
      if (sub === "reset" && tail.includes("--hard")) return "discards work (git reset --hard)";
      if (sub === "clean" && (hasShort(tail, "f") || hasLong(tail, "--force"))) return "deletes untracked files (git clean)";
      if ((sub === "checkout" || sub === "switch") && (hasShort(tail, "f") || hasLong(tail, "--force", "--discard-changes")))
        return "discards work (forced checkout)";
      if (sub === "branch" && hasShort(tail, "D")) return "force-deletes a branch (git branch -D)";
    }

    const manager = word.startsWith("python") && args[0] === "-m" ? args[1] : word;
    const verbs = INSTALLERS[manager];
    if (verbs) {
      const rest = word.startsWith("python") ? args.slice(2) : args;
      // Not just the first word: `npm --prefix app install`, `uv pip install`.
      const sub = rest.find((a) => verbs.includes(a));
      if (sub) return `installs packages (${manager} ${sub})`;
    }

    if (word === "curl") {
      const upload =
        hasLong(args, "--data", "--data-binary", "--data-raw", "--data-urlencode", "--data-ascii", "--form", "--json", "--upload-file") ||
        hasShort(args, "dFT") ||
        args.some((a, i) => (a === "-X" || a === "--request" ? !/^(GET|HEAD)$/i.test(args[i + 1] ?? "") : /^-X./.test(a) && !/^-X(GET|HEAD)$/i.test(a)));
      if (upload) return "uploads data (curl)";
    }
    if (word === "wget" && hasLong(args, "--post-data", "--post-file", "--body-data", "--body-file", "--method")) {
      if (!hasLong(args, "--method") || args.some((a) => /^--method=(?!GET$|HEAD$)/i.test(a))) return "uploads data (wget)";
    }

    // Writes into a dotfile directly under the home directory (`~/.zshrc`, `~/.ssh/...`).
    const redirects = [...text.matchAll(/>>?\s*(\S+)/g)].map((m) => unquote(m[1]));
    const writes = redirects.length > 0 || WRITERS.has(word);
    if (writes) {
      const candidates = [...redirects, ...(WRITERS.has(word) ? args.filter((a) => !a.startsWith("-")) : [])];
      for (const raw of candidates) {
        const expanded = expandPath(raw, home);
        if (expanded === undefined) continue;
        const target = resolve(cwd, expanded);
        if (target !== home && inside(home, target) && relative(home, target).split("/")[0].startsWith("."))
          return "writes a dotfile in the home folder";
      }
    }
  }
  return undefined;
}

/** Why `command` needs approval under the guard file and the built-in list, or undefined if it can just run. */
export function riskOf(command: string, cwd: string, home: string, rules: GuardRules): string | undefined {
  if (rules.ask.some((p) => p.test(command))) return "matches an `ask` pattern in guard.json";
  if (rules.allow.some((p) => p.test(command))) return undefined;
  return defaultRisk(command, cwd, home);
}

// ------------------------------------------------------------------ the extension

const APPROVED = new Set(["approve", "approved", "yes", "y", "ok", "allow"]);

export function createGuard(
  opts: { guardFile?: string; home?: string; warn?: (message: string) => void } = {},
): Extension {
  const home = opts.home ?? homedir();
  const guardFile = opts.guardFile ?? join(home, ".durable-jim-agent", "guard.json");
  const warn = opts.warn ?? ((m: string) => console.error(`[guard] ${m}`));
  const coding = (name: string) => CodingTools.tools!.find((t) => t.name === name) as ToolRegistration;

  const workspaceLimit = (name: "write" | "edit") =>
    wrapTool(coding(name), (tool) => ({
      ...tool,
      execute: async (args, api, context) => {
        const cwd = (await api.agent(context)).cwd ?? process.cwd();
        const path = (args as { path?: unknown }).path;
        if (typeof path !== "string" || !withinWorkspace(cwd, path, home))
          throw Error(`Blocked: ${String(path)} is outside the workspace (${cwd}). ${name} only works inside the workspace.`);
        return tool.execute(args, api, context);
      },
    }));

  const approval = wrapTool(coding("bash"), (tool) => ({
    ...tool,
    execute: async (args, api, context) => {
      const command = String((args as { command?: unknown }).command ?? "");
      const cwd = (await api.agent(context)).cwd ?? process.cwd();
      const reason = riskOf(command, cwd, home, readRules(guardFile, warn));
      const trusted = (await api.snapshot(AttentionDoc, api.conversationId, context))?.trusted === true;
      if (reason && !trusted) {
        const asked = await askAndWait(
          { question: `Approve running this command? It ${reason}.\n\n${command}`, choices: ["Approve", "Deny"] },
          api,
          context,
        );
        const answer = (asked.output ?? []).map((b) => (b.type === "text" ? b.text : "")).join("").trim();
        if (asked.isError || !APPROVED.has(answer.toLowerCase()))
          throw Error(`Command not run: it ${reason}, and the user did not approve it (answer: ${answer || "none"}).`);
      }
      return tool.execute(args, api, context);
    },
  }));

  return defineExtension({ name: "guard", wraps: [workspaceLimit("write"), workspaceLimit("edit"), approval] });
}
