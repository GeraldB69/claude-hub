#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { printable } from "./core/printable.js";
import { realRuntime } from "./core/process.js";
import { main } from "./main.js";

const home = process.env["CH_HOME"] ?? homedir();
const workspace = join(home, "workspace");
const claudeConfigDir = process.env["CLAUDE_CONFIG_DIR"];

process.exitCode = main(
  process.argv.slice(2),
  {
    home,
    configDir: process.env["CH_CONFIG_DIR"] ?? join(workspace, "_config"),
    defaultRoots: [workspace],
    workspaceRoot: workspace,
    examplesDir: fileURLToPath(new URL("../examples", import.meta.url)),
    cwd: process.cwd(),
    stateDir: process.env["CH_STATE_DIR"] ?? join(home, ".local/state/claude-hub"),
    ...(claudeConfigDir === undefined || claudeConfigDir === "" ? {} : { claudeConfigDir }),
  },
  { out: (line) => console.log(printable(line)), err: (line) => console.error(printable(line)) },
  realRuntime
);
