import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

import type { ClaudeProcess } from "./env.js";

/** Profondeur maximale de la remontée des parents : garde contre une chaîne corrompue. */
const MAX_ANCESTORS = 64;
/** Interpréteurs par lesquels Claude Code peut être lancé (`node …/claude-code/cli.js`). */
const RUNNERS: ReadonlySet<string> = new Set(["node", "nodejs", "bun", "deno"]);
const DELETED_SUFFIX = / \(deleted\)$/;

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readLink(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Un processus est Claude Code si son nom (`comm`) ou son exécutable est exactement `claude`, ou si un
 * interpréteur (`node`, `bun`, `deno`) lance un script nommé `claude` ou le paquet `@anthropic-ai/claude-code`.
 */
function isClaude(processDir: string): boolean {
  if (readText(join(processDir, "comm"))?.trim() === "claude") {
    return true;
  }
  const [executable, ...args] = (readText(join(processDir, "cmdline")) ?? "").split("\0").filter((part) => part !== "");
  if (executable === undefined) {
    return false;
  }
  return (
    basename(executable) === "claude" ||
    (RUNNERS.has(basename(executable)) &&
      args.some((arg) => basename(arg) === "claude" || arg.includes("@anthropic-ai/claude-code")))
  );
}

/** Un processus zombie (état `Z`) ne tient plus de session ; son dossier de travail est illisible. */
function isZombie(processDir: string): boolean {
  const stat = readText(join(processDir, "stat"));
  const end = stat?.lastIndexOf(")") ?? -1;
  return stat !== undefined && end !== -1 && stat.charAt(end + 2) === "Z";
}

/** PID du parent, lu dans `/proc/<pid>/stat` (le nom de commande entre parenthèses peut contenir des espaces et des parenthèses). */
function parentOf(procRoot: string, pid: number): number | undefined {
  const stat = readText(join(procRoot, String(pid), "stat"));
  const end = stat?.lastIndexOf(")") ?? -1;
  const parent = Number(stat?.slice(end + 2).split(" ")[1]);
  return stat !== undefined && end !== -1 && Number.isInteger(parent) ? parent : undefined;
}

function ancestorsOf(procRoot: string, selfPid: number): ReadonlySet<number> {
  const chain = new Set<number>();
  let current = selfPid;
  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    const parent = parentOf(procRoot, current);
    if (parent === undefined || parent <= 0 || chain.has(parent)) {
      break;
    }
    chain.add(parent);
    current = parent;
  }
  return chain;
}

/**
 * Liste les sessions Claude Code en cours (Linux, via `/proc`), leur dossier de travail et si elles sont un
 * ancêtre du processus courant. Le processus courant lui-même et les zombies sont ignorés. Lecture seule. Échoue si `/proc` est illisible : mieux vaut refuser que de
 * conclure à tort qu'aucune session n'est ouverte.
 */
export function listClaudeProcesses(procRoot = "/proc", selfPid: number = process.pid): readonly ClaudeProcess[] {
  let names: string[];
  try {
    names = readdirSync(procRoot);
  } catch {
    throw new Error("/proc est illisible : la détection des sessions Claude est impossible.");
  }
  const ancestors = ancestorsOf(procRoot, selfPid);
  return names
    .filter((name) => /^\d+$/.test(name))
    .map((name) => ({ pid: Number(name), dir: join(procRoot, name) }))
    .filter(({ pid, dir }) => pid !== selfPid && !isZombie(dir) && isClaude(dir))
    .map(({ pid, dir }) => ({
      pid,
      cwd: readLink(join(dir, "cwd"))?.replace(DELETED_SUFFIX, ""),
      ancestor: ancestors.has(pid),
    }))
    .toSorted((a, b) => a.pid - b.pid);
}
