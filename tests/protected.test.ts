import { describe, expect, test } from "vitest";

import type { Env } from "../src/core/env.js";
import { protectedReason } from "../src/core/protected.js";

const env: Env = {
  home: "/home/me",
  configDir: "/home/me/workspace/_config",
  defaultRoots: [],
  workspaceRoot: "/home/me/workspace",
  examplesDir: "/x",
  cwd: "/home/me/workspace/site",
  stateDir: "/home/me/.local/state/claude-hub",
};

describe("protectedReason", () => {
  test.each([
    ["/home/me", "personnel"],
    ["/home/me/", "personnel"],
    ["/home/me/workspace", "racine de travail"],
    ["/home/me/workspace/../workspace", "racine de travail"],
    ["/", "racine du système"],
    ["/home/me/.claude", "Claude"],
    ["/home/me/.claude/projects/x", "Claude"],
  ])("refuses %s", (path, fragment) => {
    expect(protectedReason(path, env)).toContain(fragment);
  });

  test("refuses the folder CLAUDE_CONFIG_DIR points to", () => {
    expect(protectedReason("/opt/claude-cfg", { ...env, claudeConfigDir: "/opt/claude-cfg" })).toContain("Claude");
  });

  test.each(["/home/me/workspace/site", "/home/me/workspace-other/site", "/home/me/.claudex", "/srv/app"])(
    "accepts %s",
    (path) => {
      expect(protectedReason(path, env)).toBeUndefined();
    }
  );
});
