import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { formatIssues, parseYamlDocument } from "./parse.js";

/** Nom de profil ou de projet : minuscules, chiffres et tirets, jamais de séparateur de chemin. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/**
 * `plugin@marketplace`, jamais un `-` initial : l'identifiant est passé en argument à `claude plugin install`
 * et ne doit pas pouvoir devenir une option. Pas de séparateur de chemin ni de caractère de contrôle.
 */
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][\w.-]*@[A-Za-z0-9][\w.-]*$/;
const MAX_INHERITANCE_DEPTH = 8;

const profileSchema = z.strictObject({
  extends: z.string().regex(NAME_PATTERN).optional(),
  plugins: z.array(z.string().regex(PLUGIN_ID_PATTERN)).default([]),
  skillsOff: z.array(z.string().min(1)).default([]),
  connectors: z.enum(["disabled", "default"]).optional(),
  claudeMd: z.string().optional(),
});

export type ProfileDocument = z.infer<typeof profileSchema>;

/** Profil après résolution de l'héritage. */
export interface Profile {
  readonly name: string;
  /** Identifiants `plugin@marketplace` à activer au scope projet. */
  readonly plugins: readonly string[];
  /** Skills à passer à « off » dans `skillOverrides`. */
  readonly skillsOff: readonly string[];
  readonly connectors: "disabled" | "default";
  /** Contenu proposé pour le CLAUDE.md d'un nouveau projet. */
  readonly claudeMd?: string;
}

export interface ProfileSources {
  readonly configDir: string;
  /** Dossier `examples` livré avec l'engine, contenant `profiles/`. */
  readonly examplesDir: string;
}

/** Valide le texte YAML d'un profil. */
export function parseProfileDocument(yamlText: string): ProfileDocument {
  const result = profileSchema.safeParse(parseYamlDocument(yamlText));
  if (!result.success) {
    throw new Error(`Profil invalide : ${formatIssues(result.error)}`);
  }
  return result.data;
}

const union = (parent: readonly string[], child: readonly string[]): string[] => [
  ...new Set([...parent, ...child]),
];

function findProfileFile(name: string, sources: ProfileSources): string {
  const candidates = [
    join(sources.configDir, "profiles", `${name}.yaml`),
    join(sources.examplesDir, "profiles", `${name}.yaml`),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`Profil introuvable : ${name} (cherché dans ${candidates.join(" puis ")})`);
  }
  return found;
}

function readProfileDocument(file: string): ProfileDocument {
  try {
    return parseProfileDocument(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file} : ${reason}`, { cause: error });
  }
}

function resolveProfile(name: string, sources: ProfileSources, chain: readonly string[]): Profile {
  if (chain.includes(name)) {
    throw new Error(`Cycle d'héritage de profils : ${[...chain, name].join(" → ")}`);
  }
  if (chain.length >= MAX_INHERITANCE_DEPTH) {
    throw new Error(`Héritage de profils trop profond (plus de ${MAX_INHERITANCE_DEPTH} niveaux) : ${chain.join(" → ")}`);
  }
  const document = readProfileDocument(findProfileFile(name, sources));
  const parent =
    document.extends === undefined ? undefined : resolveProfile(document.extends, sources, [...chain, name]);
  const claudeMd = document.claudeMd ?? parent?.claudeMd;
  return {
    name,
    plugins: union(parent?.plugins ?? [], document.plugins),
    skillsOff: union(parent?.skillsOff ?? [], document.skillsOff),
    connectors: document.connectors ?? parent?.connectors ?? "default",
    ...(claudeMd === undefined ? {} : { claudeMd }),
  };
}

/** Charge un profil : configuration privée d'abord, exemples de l'engine ensuite ; l'héritage est résolu. */
export function loadProfile(name: string, sources: ProfileSources): Profile {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Nom de profil invalide : « ${name} » (minuscules, chiffres et tirets)`);
  }
  return resolveProfile(name, sources, []);
}
