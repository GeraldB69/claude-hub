import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { findExecutable } from "../src/core/which.js";

import { createFakeHome, type FakeHome } from "./helpers/fake-home.js";

const isRoot = process.getuid?.() === 0;

describe("findExecutable", () => {
  let fake: FakeHome;

  const makeBinary = (dir: string, mode = 0o755): string => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "claude");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, mode);
    return file;
  };

  beforeEach(() => {
    fake = createFakeHome();
  });

  afterEach(() => {
    fake.cleanup();
  });

  test("returns the first executable found in the absolute PATH entries", () => {
    const first = makeBinary(join(fake.home, "a"));
    makeBinary(join(fake.home, "b"));

    expect(findExecutable("claude", `${join(fake.home, "a")}:${join(fake.home, "b")}`)).toBe(first);
  });

  test("ignores empty and relative entries, which would resolve against the current folder", () => {
    const real = makeBinary(join(fake.home, "real"));
    makeBinary(join(fake.home, "rel"));

    expect(findExecutable("claude", `::.:rel:../x:${join(fake.home, "real")}`)).toBe(real);
  });

  test.skipIf(isRoot)("skips a file that is not executable", () => {
    makeBinary(join(fake.home, "a"), 0o644);
    const good = makeBinary(join(fake.home, "b"));

    expect(findExecutable("claude", `${join(fake.home, "a")}:${join(fake.home, "b")}`)).toBe(good);
  });

  test("skips a directory named like the command", () => {
    mkdirSync(join(fake.home, "a/claude"), { recursive: true });
    const good = makeBinary(join(fake.home, "b"));

    expect(findExecutable("claude", `${join(fake.home, "a")}:${join(fake.home, "b")}`)).toBe(good);
  });

  test("returns undefined when nothing matches or PATH is unset or empty", () => {
    expect(findExecutable("claude", join(fake.home, "empty"))).toBeUndefined();
    expect(findExecutable("claude", undefined)).toBeUndefined();
    expect(findExecutable("claude", "")).toBeUndefined();
  });

  test("never accepts a command name containing a path separator", () => {
    makeBinary(join(fake.home, "a"));

    expect(findExecutable("a/claude", fake.home)).toBeUndefined();
    expect(findExecutable("../claude", fake.home)).toBeUndefined();
  });
});
