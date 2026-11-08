import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Env, Io, Runtime } from "../src/core/env.js";
import { main } from "../src/main.js";

import { testEnv } from "./helpers/env.js";
import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

describe("main", () => {
  let fake: FakeHome;
  let env: Env;
  let stdout: string[];
  let stderr: string[];
  let io: Io;
  const runtime: Runtime = { launchClaude: () => 0, claudeProcesses: () => [] };

  beforeEach(() => {
    fake = createFakeHome();
    env = testEnv(fake);
    stdout = [];
    stderr = [];
    io = { out: (line) => stdout.push(line), err: (line) => stderr.push(line) };
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("dispatches the ls command", () => {
    const code = main(["ls"], env, io, runtime);

    expect(code).toBe(0);
  });

  test("dispatches the audit command", () => {
    const code = main(["audit"], env, io, runtime);

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("Aucun écart");
  });

  test.each(["--help", "-h"])("prints the usage and exits 0 on %s", (flag) => {
    const code = main([flag], env, io, runtime);

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("ch audit");
  });

  test("dispatches init and open, which both need a project argument", () => {
    expect(main(["init"], env, io, runtime)).toBe(2);
    expect(main(["open"], env, io, runtime)).toBe(2);
  });

  test("prints the usage and exits 2 when no command is given", () => {
    const code = main([], env, io, runtime);

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("Usage");
  });

  test("exits 2 on an unknown command and names it", () => {
    const code = main(["frobnicate"], env, io, runtime);

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("frobnicate");
  });
});
