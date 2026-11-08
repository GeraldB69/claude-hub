import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { listClaudeProcesses } from "../src/core/proc.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

describe("listClaudeProcesses", () => {
  let fake: FakeHome;
  let proc: string;

  const addProcess = (pid: string, comm: string, argv0: string, cwd?: string, ...more: string[]) => {
    const dir = join(proc, pid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "comm"), `${comm}\n`);
    writeFileSync(join(dir, "cmdline"), [argv0, ...more, "--flag"].join("\0") + "\0");
    if (cwd !== undefined) {
      symlinkSync(cwd, join(dir, "cwd"));
    }
  };

  beforeEach(() => {
    fake = createFakeHome();
    proc = fake.makeDir("proc");
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("returns the claude processes with their working folder", () => {
    addProcess("10", "claude", "claude", "/ws/site");
    addProcess("11", "node", "node", "/ws/other");

    expect(listClaudeProcesses(proc, 1)).toEqual([{ pid: 10, cwd: "/ws/site", ancestor: false }]);
  });

  test("recognises claude by the name of its executable even when comm differs", () => {
    addProcess("12", "MainThread", "/home/me/.local/share/claude/versions/2.1/claude", "/ws/site");

    expect(listClaudeProcesses(proc, 1).map((process) => process.pid)).toEqual([12]);
  });

  test("does not mistake a process whose name merely contains claude", () => {
    addProcess("13", "claude-hud", "/usr/bin/claude-hud", "/ws/x");

    expect(listClaudeProcesses(proc, 1)).toEqual([]);
  });

  test("keeps a claude process whose folder cannot be read, with an undefined cwd", () => {
    addProcess("14", "claude", "claude");

    expect(listClaudeProcesses(proc, 1)).toEqual([{ pid: 14, cwd: undefined, ancestor: false }]);
  });

  test("ignores entries that are not process folders", () => {
    mkdirSync(join(proc, "self"));
    writeFileSync(join(proc, "uptime"), "1 2");
    addProcess("15", "claude", "claude", "/ws/a");

    expect(listClaudeProcesses(proc, 1)).toEqual([{ pid: 15, cwd: "/ws/a", ancestor: false }]);
  });

  test("fails closed instead of reporting no session when /proc cannot be read", () => {
    expect(() => listClaudeProcesses(join(fake.home, "missing"))).toThrow(/\/proc/);
  });

  test("recognises claude started through node or bun by the package or script it runs", () => {
    addProcess("20", "node", "node", "/ws/a", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js");
    addProcess("21", "bun", "/usr/bin/bun", "/ws/b", "/opt/claude");
    addProcess("22", "vim", "vim", "/ws/c", "claude");
    addProcess("23", "node", "node", "/ws/d", "server.js");

    expect(listClaudeProcesses(proc, 1).map((process) => process.pid)).toEqual([20, 21]);
  });

  test("drops the suffix the kernel adds to the folder of a process whose folder was deleted", () => {
    addProcess("30", "claude", "claude", "/ws/gone (deleted)");

    expect(listClaudeProcesses(proc, 1)[0]?.cwd).toBe("/ws/gone");
  });

  test("marks the sessions that are ancestors of the current process", () => {
    const writeStat = (pid: string, comm: string, ppid: number) =>
      writeFileSync(join(proc, pid, "stat"), `${pid} (${comm}) S ${ppid} 1 1 0\n`);
    addProcess("40", "claude", "claude", "/ws/a");
    addProcess("41", "claude", "claude", "/ws/b");
    mkdirSync(join(proc, "42"));
    mkdirSync(join(proc, "43"));
    writeStat("40", "claude", 1);
    writeStat("41", "claude", 1);
    writeStat("42", "bash (odd) name", 40);
    writeStat("43", "node", 42);

    const result = listClaudeProcesses(proc, 43);

    expect(result.map((process) => [process.pid, process.ancestor])).toEqual([
      [40, true],
      [41, false],
    ]);
  });

  test("ignores a zombie claude process, which holds no session and whose folder is unreadable", () => {
    addProcess("60", "claude", "claude", "/ws/a");
    writeFileSync(join(proc, "60", "stat"), "60 (claude) Z 1 1 1 0\n");
    addProcess("61", "claude", "claude", "/ws/b");
    writeFileSync(join(proc, "61", "stat"), "61 (claude) S 1 1 1 0\n");

    expect(listClaudeProcesses(proc, 1).map((process) => process.pid)).toEqual([61]);
  });

  test("never lists the current process itself, even when its arguments mention claude", () => {
    addProcess("70", "node", "node", "/ws/a", "/opt/ch/main.js", "move", "site", "claude");
    addProcess("71", "claude", "claude", "/ws/b");

    expect(listClaudeProcesses(proc, 70).map((process) => process.pid)).toEqual([71]);
  });

  test("does not loop forever on a corrupted parent chain", () => {
    mkdirSync(join(proc, "50"));
    writeFileSync(join(proc, "50", "stat"), "50 (x) S 50 1 1\n");
    addProcess("51", "claude", "claude", "/ws/a");

    expect(listClaudeProcesses(proc, 50).map((process) => process.ancestor)).toEqual([false]);
  });
});
