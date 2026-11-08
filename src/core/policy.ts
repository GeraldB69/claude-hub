import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { formatIssues, parseYamlDocument } from "./parse.js";
import type { Policy } from "./types.js";

export const POLICY_FILE_NAME = "policy.yaml";

const policySchema = z.strictObject({
  userPluginAllowlist: z.array(z.string().min(1)).default([]),
  agentsSkillsMustBeEmpty: z.boolean().default(true),
  allowAccountSync: z.boolean().default(false),
});

/** Valeurs par défaut : une seule source, le schéma. */
export const DEFAULT_POLICY: Policy = Object.freeze(policySchema.parse({}));

/** Interprète un document YAML de politique ; les champs absents prennent leur valeur par défaut. */
export function parsePolicy(yamlText: string): Policy {
  const result = policySchema.safeParse(parseYamlDocument(yamlText));
  if (!result.success) {
    throw new Error(`Politique invalide : ${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Charge `policy.yaml` du dossier de configuration, ou la politique par défaut s'il est absent. */
export function loadPolicy(configDir: string): Policy {
  const file = join(configDir, POLICY_FILE_NAME);
  if (!existsSync(file)) {
    return DEFAULT_POLICY;
  }
  try {
    return parsePolicy(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} : ${reason}`, { cause: error });
  }
}
