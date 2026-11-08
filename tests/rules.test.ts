import { describe, expect, test } from "vitest";

import { DEFAULT_POLICY } from "../src/core/policy.js";
import { runRules } from "../src/core/rules.js";
import type { Policy, Snapshot } from "../src/core/types.js";

const emptySnapshot: Snapshot = {
  home: "/home/test",
  plugins: [],
  agentsSkills: [],
  brokenSkillLinks: [],
  projectKeys: [],
  liveProjects: [],
  repoPaths: [],
  strayDirs: [],
  skipped: [],
  syncedPlugins: [],
  syncedSkills: [],
  syncSettings: {},
};

const snapshot = (overrides: Partial<Snapshot>): Snapshot => ({ ...emptySnapshot, ...overrides });
const policy = (overrides: Partial<Policy>): Policy => ({ ...DEFAULT_POLICY, ...overrides });

describe("runRules", () => {
  test("returns no finding for an empty snapshot", () => {
    expect(runRules(emptySnapshot, DEFAULT_POLICY)).toEqual([]);
  });

  describe("plugin-user-scope", () => {
    test("warns when a user-scope plugin is not in the allowlist", () => {
      const findings = runRules(
        snapshot({ plugins: [{ id: "foo@market", scope: "user" }] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({
          rule: "plugin-user-scope",
          severity: "warn",
          subject: "foo@market",
        }),
      ]);
    });

    test("accepts a user-scope plugin listed in the allowlist", () => {
      const findings = runRules(
        snapshot({ plugins: [{ id: "foo@market", scope: "user" }] }),
        policy({ userPluginAllowlist: ["foo@market"] })
      );

      expect(findings).toEqual([]);
    });

    test("ignores project and local scope plugins", () => {
      const findings = runRules(
        snapshot({
          plugins: [
            { id: "a@m", scope: "project" },
            { id: "b@m", scope: "local", projectPath: "/p", projectPathExists: true },
          ],
        }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([]);
    });
  });

  describe("plugin-unknown-scope", () => {
    test("informs about a scope this tool does not know, without failing", () => {
      const findings = runRules(
        snapshot({ plugins: [{ id: "z@m", scope: "unknown", rawScope: "flag" }] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({
          rule: "plugin-unknown-scope",
          severity: "info",
          subject: "z@m",
          message: expect.stringContaining("flag"),
        }),
      ]);
    });
  });

  describe("plugin-local-stale", () => {
    test("warns when a local plugin points to a project folder that no longer exists", () => {
      const findings = runRules(
        snapshot({
          plugins: [{ id: "x@m", scope: "local", projectPath: "/gone", projectPathExists: false }],
        }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({ rule: "plugin-local-stale", subject: "x@m", severity: "warn" }),
      ]);
    });
  });

  describe("agents-skills-nonempty", () => {
    test("warns about the entries of ~/.agents/skills that nothing links from ~/.claude/skills", () => {
      const findings = runRules(
        snapshot({
          agentsSkills: [
            { name: "a", linked: false },
            { name: "b", linked: false },
            { name: "c", linked: true },
          ],
        }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({
          rule: "agents-skills-nonempty",
          severity: "warn",
          message: expect.stringContaining("2 entrée"),
        }),
      ]);
    });

    test("stays silent when every entry is linked from ~/.claude/skills", () => {
      const findings = runRules(
        snapshot({ agentsSkills: [{ name: "c", linked: true }] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([]);
    });

    test("stays silent when the policy allows the folder", () => {
      const findings = runRules(
        snapshot({ agentsSkills: [{ name: "a", linked: false }] }),
        policy({ agentsSkillsMustBeEmpty: false })
      );

      expect(findings).toEqual([]);
    });
  });

  describe("skill-broken-link", () => {
    test("warns about a symlink of ~/.claude/skills whose target is missing", () => {
      const findings = runRules(
        snapshot({ brokenSkillLinks: ["/home/test/.claude/skills/ghost"] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({
          rule: "skill-broken-link",
          severity: "warn",
          subject: "/home/test/.claude/skills/ghost",
        }),
      ]);
    });
  });

  describe("stray folders", () => {
    test("warns for a non-git folder with sub-folders holding .claude or .agents", () => {
      const findings = runRules(
        snapshot({
          strayDirs: [{ path: "/ws/gbwc", entries: [".claude", "CLAUDE.md"], hasChildProjects: true }],
        }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({
          rule: "stray-parent-config",
          severity: "warn",
          subject: "/ws/gbwc",
        }),
      ]);
    });

    test("only informs when a parent folder holds just a CLAUDE.md, which children inherit", () => {
      const findings = runRules(
        snapshot({
          strayDirs: [{ path: "/ws/gbwc", entries: ["CLAUDE.md"], hasChildProjects: true }],
        }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({ rule: "stray-parent-claude-md", severity: "info" }),
      ]);
    });

    test("reports a leaf folder without git as a project whose configuration is not versioned", () => {
      const findings = runRules(
        snapshot({
          strayDirs: [{ path: "/ws/leaf", entries: [".claude", "CLAUDE.md"], hasChildProjects: false }],
        }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({
          rule: "project-without-git",
          severity: "info",
          subject: "/ws/leaf",
        }),
      ]);
    });
  });

  describe("orphan-project-key", () => {
    test("informs about a project key that matches no existing project and says not to delete on that basis alone", () => {
      const findings = runRules(
        snapshot({ projectKeys: ["-ws-live", "-ws-gone"], liveProjects: ["/ws/live"] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({
          rule: "orphan-project-key",
          severity: "info",
          subject: "-ws-gone",
          message: expect.stringContaining("supprimer"),
        }),
      ]);
    });

    test("does not report the key of a git repository found on disk but absent from ~/.claude.json", () => {
      const findings = runRules(
        snapshot({ projectKeys: ["-ws-repo"], repoPaths: ["/ws/repo"] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([]);
    });

    test("does not report the key of a sub-folder of a git repository found on disk", () => {
      const findings = runRules(
        snapshot({ projectKeys: ["-ws-repo-sub-dir"], repoPaths: ["/ws/repo"] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([]);
    });

    test("does not let a live ancestor folder such as the home hide every other key", () => {
      const findings = runRules(
        snapshot({ projectKeys: ["-home-me-oldproj"], liveProjects: ["/home/me"] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([
        expect.objectContaining({ rule: "orphan-project-key", subject: "-home-me-oldproj" }),
      ]);
    });

    test("does not report the key of a non-git project folder found on disk", () => {
      const findings = runRules(
        snapshot({
          projectKeys: ["-ws-leaf"],
          strayDirs: [{ path: "/ws/leaf", entries: [".claude"], hasChildProjects: false }],
        }),
        DEFAULT_POLICY
      );

      expect(findings.map((finding) => finding.rule)).toEqual(["project-without-git"]);
    });

    test("does not report truncated keys, whose path cannot be recomputed", () => {
      const findings = runRules(
        snapshot({ projectKeys: [`-${"x".repeat(220)}`] }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([]);
    });
  });

  describe("project-key-too-long", () => {
    test("reports an error when a live project path gives an unreliable key", () => {
      const longPath = `/${"x".repeat(250)}`;

      const findings = runRules(snapshot({ liveProjects: [longPath] }), DEFAULT_POLICY);

      expect(findings).toEqual([
        expect.objectContaining({ rule: "project-key-too-long", severity: "error" }),
      ]);
    });
  });

  describe("account-sync-enabled", () => {
    const syncedSnapshot = (overrides: Partial<Snapshot>): Snapshot =>
      snapshot({ syncedPlugins: ["a", "b"], syncedSkills: ["pdf"], ...overrides });

    test("warns that plugins and skills synchronised from the claude.ai account load in every project", () => {
      const findings = runRules(syncedSnapshot({}), DEFAULT_POLICY);

      expect(findings).toEqual([
        expect.objectContaining({
          rule: "account-sync-enabled",
          severity: "warn",
          message: expect.stringContaining("2 plugin"),
        }),
      ]);
      expect(findings[0]?.message).toContain("1 skill");
    });

    test("stays silent when both synchronisations are switched off", () => {
      const findings = runRules(
        syncedSnapshot({ syncSettings: { plugins: false, skills: false } }),
        DEFAULT_POLICY
      );

      expect(findings).toEqual([]);
    });

    test("only mentions what is still synchronised when one switch is off", () => {
      const findings = runRules(
        syncedSnapshot({ syncSettings: { plugins: false, skills: true } }),
        DEFAULT_POLICY
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).not.toContain("plugin");
      expect(findings[0]?.message).toContain("1 skill");
    });

    test("stays silent when nothing is synchronised on disk", () => {
      const findings = runRules(snapshot({}), DEFAULT_POLICY);

      expect(findings).toEqual([]);
    });

    test("stays silent when the policy allows account synchronisation", () => {
      const findings = runRules(syncedSnapshot({}), policy({ allowAccountSync: true }));

      expect(findings).toEqual([]);
    });
  });

  describe("scan-skipped", () => {
    test("informs about each path the scan could not read, so the audit is never silently partial", () => {
      const findings = runRules(snapshot({ skipped: ["/ws/locked"] }), DEFAULT_POLICY);

      expect(findings).toEqual([
        expect.objectContaining({ rule: "scan-skipped", severity: "info", subject: "/ws/locked" }),
      ]);
    });
  });

  test("orders findings from the most to the least severe", () => {
    const findings = runRules(
      snapshot({
        plugins: [{ id: "foo@m", scope: "user" }],
        projectKeys: ["-orphan"],
        liveProjects: [`/${"y".repeat(250)}`],
      }),
      DEFAULT_POLICY
    );

    expect(findings.map((finding) => finding.severity)).toEqual(["error", "warn", "info"]);
  });
});
