import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "vitest";

/**
 * Garde-fou statique sur les sources. Trois catégories de modules :
 *  - lecture seule (tout `src/` par défaut) : seules des fonctions de lecture de `node:fs`, rien d'autre ;
 *  - le moteur d'écriture `core/fs-safe.ts` : seul à pouvoir écrire, et rien d'autre (ni processus, ni réseau) ;
 *  - le lanceur `core/process.ts` : seul à pouvoir lancer un processus (`spawnSync`), et sans accès au disque.
 * Seuls les importeurs prévus peuvent utiliser le moteur d'écriture ; personne dans `src/` (hors `cli.ts`,
 * qui branche la console) n'importe le lanceur : les commandes le reçoivent en paramètre.
 * Heuristique par analyse de texte : elle complète la revue, elle ne la remplace pas.
 */
const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const EXCLUDED_FILE = "cli.ts";

const WRITER = "core/fs-safe.ts";
const LAUNCHER = "core/process.ts";
const WRITER_IMPORTERS: ReadonlySet<string> = new Set(["commands/init.ts", "commands/apply.ts", "commands/move.ts", "commands/gc.ts"]);
const LAUNCHER_IMPORTERS: ReadonlySet<string> = new Set([]);

const READ_ONLY_FS: ReadonlySet<string> = new Set([
  "existsSync",
  "readdirSync",
  "readFileSync",
  "readlinkSync",
  "realpathSync",
  "statSync",
  "lstatSync",
  "accessSync",
  "constants",
  "Dirent",
  "Stats",
]);

const NAMED_FS_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](?:node:)?fs["']/g;
const FS_OR_PROCESS = "(?:fs|fs\\/promises|child_process)";
const NAMED_CHILD_PROCESS_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](?:node:)?child_process["']/g;
const ANY_FS_IMPORT = /from\s+["'](?:node:)?fs(?:\/promises)?["']/;
const NETWORK_MODULE =
  /from\s+["'](?:node:)?(?:http|https|http2|net|dns|dgram|tls|cluster|vm|worker_threads|inspector|repl|sqlite|readline|zlib|v8|module)["']/;
const PROMISES_OR_PROCESS_MODULE = /from\s+["'](?:node:)?(?:fs\/promises|child_process)["']/;
const NON_NAMED_IMPORT = new RegExp(
  `import\\s+(?:type\\s+)?(?:\\*\\s+as\\s+\\w+|\\w+)\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s+["'](?:node:)?${FS_OR_PROCESS}["']`
);
const REEXPORT = new RegExp(
  `export\\s+(?:type\\s+)?(?:\\{[^}]*\\}|\\*)\\s+from\\s+["'](?:node:)?${FS_OR_PROCESS}["']`
);
const DYNAMIC_ACCESS =
  /\b(?:import\s*\(|require\s*\(|createRequire|getBuiltinModule|process\.(?:binding|dlopen|kill|chdir)|import\.meta\.resolve|eval\s*\(|new\s+Function\b|WebSocket\b|fetch\s*\()|globalThis\s*\[/;
const WRITE_FLAG = /\bflag\s*:/;
const SHELL_OPTION = /\bshell\s*:/;

const importedNames = (source: string, pattern: RegExp): string[] =>
  [...source.matchAll(pattern)].flatMap((match) =>
    (match[1] ?? "")
      .split(",")
      .map((name) => name.trim().replace(/^type\s+/, "").replace(/\s+as\s+\w+$/, ""))
      .filter((name) => name !== "")
  );

const outsideOf = (names: readonly string[], allowed: ReadonlySet<string>): string[] =>
  names.filter((name) => !allowed.has(name));

/** Modules en lecture seule : liste blanche de lectures, aucun effet de bord. */
export function readOnlyViolations(source: string): string[] {
  return [
    ...outsideOf(importedNames(source, NAMED_FS_IMPORT), READ_ONLY_FS).map((name) => `import fs non autorisé : ${name}`),
    ...(PROMISES_OR_PROCESS_MODULE.test(source) || NETWORK_MODULE.test(source) ? ["module à effet de bord"] : []),
    ...(NON_NAMED_IMPORT.test(source) ? ["import global ou par défaut"] : []),
    ...(REEXPORT.test(source) ? ["réexportation d'un module sensible"] : []),
    ...(DYNAMIC_ACCESS.test(source) ? ["accès dynamique ou réseau"] : []),
    ...(WRITE_FLAG.test(source) ? ["option flag (écriture possible)"] : []),
  ];
}

/** Moteur d'écriture : peut écrire (option `flag` comprise), mais ni processus, ni réseau, ni accès dynamique. */
export function writerViolations(source: string): string[] {
  return [
    ...(PROMISES_OR_PROCESS_MODULE.test(source) || NETWORK_MODULE.test(source) ? ["module à effet de bord"] : []),
    ...(NON_NAMED_IMPORT.test(source) ? ["import global ou par défaut"] : []),
    ...(REEXPORT.test(source) ? ["réexportation d'un module sensible"] : []),
    ...(DYNAMIC_ACCESS.test(source) ? ["accès dynamique ou réseau"] : []),
  ];
}

/** Lanceur : seul `spawnSync` de `child_process`, aucun accès au disque, ni réseau, ni accès dynamique. */
export function launcherViolations(source: string): string[] {
  return [
    ...outsideOf(importedNames(source, NAMED_CHILD_PROCESS_IMPORT), new Set(["spawnSync"])).map(
      (name) => `import child_process non autorisé : ${name}`
    ),
    ...(ANY_FS_IMPORT.test(source) ? ["accès au disque"] : []),
    ...(NETWORK_MODULE.test(source) ? ["module réseau"] : []),
    ...(NON_NAMED_IMPORT.test(source) ? ["import global ou par défaut"] : []),
    ...(REEXPORT.test(source) ? ["réexportation d'un module sensible"] : []),
    ...(DYNAMIC_ACCESS.test(source) ? ["accès dynamique ou réseau"] : []),
    ...(SHELL_OPTION.test(source) ? ["option shell"] : []),
  ];
}

const importsModule = (source: string, moduleName: string): boolean =>
  new RegExp(`from\\s+["'][^"']*/${moduleName}(?:\\.js|\\.ts)?["']`).test(source);

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".ts") ? [path] : [];
  });

const violationsFor = (file: string, source: string): string[] =>
  file === WRITER ? writerViolations(source) : file === LAUNCHER ? launcherViolations(source) : readOnlyViolations(source);

describe("guard on the sources", () => {
  const files = sourceFiles(SOURCE_ROOT)
    .map((path) => relative(SOURCE_ROOT, path))
    .filter((file) => file !== EXCLUDED_FILE);
  const read = (file: string): string => readFileSync(join(SOURCE_ROOT, file), "utf8");

  test("covers the files that exist, special modules included", () => {
    expect(files).toEqual(expect.arrayContaining(["core/scan.ts", "commands/audit.ts", "main.ts", WRITER, LAUNCHER]));
  });

  test.each(files)("%s respects the rules of its category", (file) => {
    expect(violationsFor(file, read(file))).toEqual([]);
  });

  test("only the planned commands import the write engine", () => {
    const importers = files.filter((file) => importsModule(read(file), "fs-safe"));

    expect(importers.filter((file) => !WRITER_IMPORTERS.has(file))).toEqual([]);
  });

  test("nothing in src imports the process launcher: commands receive it as a parameter", () => {
    const importers = files.filter((file) => importsModule(read(file), "process"));

    expect(importers.filter((file) => !LAUNCHER_IMPORTERS.has(file))).toEqual([]);
  });
});

describe("guard detection", () => {
  test.each([
    ['import { readFileSync, writeFileSync } from "node:fs";', "import fs non autorisé : writeFileSync"],
    ["import { rmSync } from 'node:fs';", "import fs non autorisé : rmSync"],
    ['import { readFileSync as read, appendFileSync as add } from "fs";', "import fs non autorisé : appendFileSync"],
    ['import { writeFile } from "node:fs/promises";', "module à effet de bord"],
    ['import { execSync } from "node:child_process";', "module à effet de bord"],
    ['import https from "node:https";', "module à effet de bord"],
    ['import * as fs from "node:fs";', "import global ou par défaut"],
    ['import fs from "fs";', "import global ou par défaut"],
    ['const fs = await import("node:fs");', "accès dynamique ou réseau"],
    ['const fs = require("fs");', "accès dynamique ou réseau"],
    ["createRequire(import.meta.url);", "accès dynamique ou réseau"],
    ['process.getBuiltinModule("fs");', "accès dynamique ou réseau"],
    ['await fetch("https://example.com");', "accès dynamique ou réseau"],
    ['readFileSync(path, { flag: "a+" });', "option flag (écriture possible)"],
    ['import fs, { readFileSync } from "node:fs";', "import global ou par défaut"],
    ['import cp, { spawnSync } from "node:child_process";', "import global ou par défaut"],
    ['export { writeFileSync } from "node:fs";', "réexportation d'un module sensible"],
    ['export * from "node:fs";', "réexportation d'un module sensible"],
    ["eval(code);", "accès dynamique ou réseau"],
    ["new Function('return 1');", "accès dynamique ou réseau"],
    ["process.kill(1, 9);", "accès dynamique ou réseau"],
    ["process.chdir('/');", "accès dynamique ou réseau"],
    ['import zlib from "node:zlib";', "module à effet de bord"],
    ['import { Database } from "node:sqlite";', "module à effet de bord"],
  ])("read-only rule flags %s", (source, expected) => {
    expect(readOnlyViolations(source)).toContain(expected);
  });

  test("read-only rule accepts read-only imports", () => {
    expect(readOnlyViolations('import { existsSync, readFileSync, type Dirent } from "node:fs";')).toEqual([]);
  });

  test("writer rule accepts writes and the flag option but refuses processes and dynamic access", () => {
    expect(writerViolations('import { writeFileSync } from "node:fs"; writeFileSync(p, c, { flag: "wx" });')).toEqual([]);
    expect(writerViolations('import { spawnSync } from "node:child_process";')).toContain("module à effet de bord");
    expect(writerViolations('await import("x");')).toContain("accès dynamique ou réseau");
    expect(writerViolations('import fs from "node:fs";')).toContain("import global ou par défaut");
  });

  test("launcher rule accepts spawnSync only and refuses disk access", () => {
    expect(launcherViolations('import { spawnSync } from "node:child_process";')).toEqual([]);
    expect(launcherViolations('import { spawnSync, execSync } from "node:child_process";')).toContain(
      "import child_process non autorisé : execSync"
    );
    expect(launcherViolations('import { readFileSync } from "node:fs";')).toContain("accès au disque");
    expect(launcherViolations('import { readFile } from "node:fs/promises";')).toContain("accès au disque");
    expect(launcherViolations('import http from "node:http";')).toContain("module réseau");
  });

  test("launcher rule refuses a shell option and a global child_process import", () => {
    expect(launcherViolations('spawnSync("claude", args, { shell: true });')).toContain("option shell");
    expect(launcherViolations('import cp, { spawnSync } from "node:child_process";')).toContain(
      "import global ou par défaut"
    );
  });

  test("the module import check tolerates other extensions", () => {
    expect(importsModule('import { x } from "../core/fs-safe.ts";', "fs-safe")).toBe(true);
    expect(importsModule('import { x } from "../core/fs-safe";', "fs-safe")).toBe(true);
    expect(importsModule('import { x } from "../core/fs-safe.js";', "fs-safe")).toBe(true);
    expect(importsModule('import { x } from "node:process";', "process")).toBe(false);
  });
});
