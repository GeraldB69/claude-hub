import { describe, expect, test } from "vitest";

import { createRuntime, type SpawnFn } from "../src/core/process.js";

const BINARY = "/opt/bin/claude";

const runtimeWith = (spawn: SpawnFn, path = "/opt/bin") =>
  createRuntime({ spawn, path, findBinary: (_name, searchPath) => (searchPath === "/opt/bin" ? BINARY : undefined) });

describe("createRuntime", () => {
  test("runs the resolved absolute binary in the folder, with the arguments, sharing the terminal", () => {
    const calls: { command: string; args: readonly string[]; cwd: string; stdio: string }[] = [];
    const runtime = runtimeWith((command, args, options) => {
      calls.push({ command, args, cwd: options.cwd, stdio: options.stdio });
      return { status: 0, signal: null };
    });

    const code = runtime.launchClaude("/ws/site", ["--model", "haiku"]);

    expect(code).toBe(0);
    expect(calls).toEqual([{ command: BINARY, args: ["--model", "haiku"], cwd: "/ws/site", stdio: "inherit" }]);
  });

  test("returns the exit code of claude", () => {
    expect(runtimeWith(() => ({ status: 7, signal: null })).launchClaude("/x", [])).toBe(7);
  });

  test("returns 128 plus the signal number when claude was killed by a signal", () => {
    expect(runtimeWith(() => ({ status: null, signal: "SIGTERM" })).launchClaude("/x", [])).toBe(143);
    expect(runtimeWith(() => ({ status: null, signal: "SIGINT" })).launchClaude("/x", [])).toBe(130);
  });

  test("returns 1 when there is neither a status nor a signal", () => {
    expect(runtimeWith(() => ({ status: null, signal: null })).launchClaude("/x", [])).toBe(1);
  });

  test("returns 127 without spawning when claude is not found in an absolute PATH entry", () => {
    let spawned = false;
    const written: string[] = [];
    const runtime = createRuntime({
      spawn: () => {
        spawned = true;
        return { status: 0, signal: null };
      },
      path: "/nowhere",
      findBinary: () => undefined,
      report: (message) => written.push(message),
    });

    expect(runtime.launchClaude("/x", [])).toBe(127);
    expect(spawned).toBe(false);
    expect(written.join("")).not.toContain("ch open");
  });

  test("returns 126 and reports the system error code when the binary cannot be started", () => {
    const written: string[] = [];
    const runtime = createRuntime({
      spawn: () => ({ status: null, signal: null, error: Object.assign(new Error("boom"), { code: "EACCES" }) }),
      path: "/opt/bin",
      findBinary: () => BINARY,
      report: (message) => written.push(message),
    });

    expect(runtime.launchClaude("/x", [])).toBe(126);
    expect(written.join("")).toContain("EACCES");
    expect(written.join("")).not.toContain("ch open");
  });

  test("keeps the parent from being killed by Ctrl-C while claude runs, and restores the handlers afterwards", () => {
    const before = process.listenerCount("SIGINT");
    let during = -1;
    const runtime = runtimeWith(() => {
      during = process.listenerCount("SIGINT");
      return { status: 0, signal: null };
    });

    runtime.launchClaude("/x", []);

    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("restores the handlers even when spawning throws", () => {
    const before = process.listenerCount("SIGTERM");
    const runtime = runtimeWith(() => {
      throw new Error("spawn exploded");
    });

    expect(() => runtime.launchClaude("/x", [])).toThrow(/exploded/);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});
