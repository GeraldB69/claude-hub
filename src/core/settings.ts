import type { Profile } from "./profile.js";

/** Clés de `settings.json` qu'un profil pilote ; toutes les autres sont laissées telles quelles. */
export interface SettingsPatch {
  readonly enabledPlugins?: Readonly<Record<string, true>>;
  readonly skillOverrides?: Readonly<Record<string, "off">>;
  readonly disableClaudeAiConnectors?: true;
}

export interface MergeResult {
  readonly merged: Record<string, unknown>;
  readonly changed: boolean;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Traduit un profil en clés de `settings.json`. */
export function settingsPatchOf(profile: Profile): SettingsPatch {
  return {
    ...(profile.plugins.length > 0
      ? { enabledPlugins: Object.fromEntries(profile.plugins.map((id) => [id, true as const])) }
      : {}),
    ...(profile.skillsOff.length > 0
      ? { skillOverrides: Object.fromEntries(profile.skillsOff.map((name) => [name, "off" as const])) }
      : {}),
    ...(profile.connectors === "disabled" ? { disableClaudeAiConnectors: true as const } : {}),
  };
}

/**
 * Fusionne le patch dans un `settings.json` existant sans le modifier : les tables de plugins et de
 * skills sont unies (le profil l'emporte sur une valeur contraire), l'ordre des clés est conservé, les
 * clés nouvelles sont ajoutées à la fin. Retourne `undefined` si une clé gérée n'est pas un objet.
 */
export function mergeSettings(
  existing: Readonly<Record<string, unknown>>,
  patch: SettingsPatch
): MergeResult | undefined {
  const tables: readonly (readonly [string, Readonly<Record<string, unknown>> | undefined])[] = [
    ["enabledPlugins", patch.enabledPlugins],
    ["skillOverrides", patch.skillOverrides],
  ];
  let merged: Record<string, unknown> = { ...existing };
  for (const [key, additions] of tables) {
    if (additions === undefined) {
      continue;
    }
    const current = existing[key];
    if (current !== undefined && !isRecord(current)) {
      return undefined;
    }
    merged = { ...merged, [key]: { ...current, ...additions } };
  }
  if (patch.disableClaudeAiConnectors === true) {
    merged = { ...merged, disableClaudeAiConnectors: true };
  }
  return { merged, changed: JSON.stringify(merged) !== JSON.stringify(existing) };
}

/** Sérialisation unique des fichiers de réglages : deux espaces d'indentation, saut de ligne final. */
export const serializeSettings = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const changesFor = (
  current: unknown,
  wanted: Readonly<Record<string, unknown>> | undefined,
  value: unknown
): string[] =>
  Object.keys(wanted ?? {}).flatMap((name) => {
    const present = isRecord(current) ? current[name] : undefined;
    if (present === value) {
      return [];
    }
    return [present === undefined ? `+${name}` : `~${name} (était ${JSON.stringify(present)})`];
  });

/**
 * Décrit en quelques mots ce que la fusion changerait : `+` pour un ajout, `~` quand le profil remplace
 * une valeur contraire déjà présente (le profil l'emporte, mais l'utilisateur doit le voir).
 */
export function summarizeMerge(existing: Readonly<Record<string, unknown>>, patch: SettingsPatch): string[] {
  const plugins = changesFor(existing["enabledPlugins"], patch.enabledPlugins, true);
  const skills = changesFor(existing["skillOverrides"], patch.skillOverrides, "off");
  const connectors = existing["disableClaudeAiConnectors"];
  return [
    ...(plugins.length > 0 ? [`enabledPlugins ${plugins.join(" ")}`] : []),
    ...(skills.length > 0 ? [`skillOverrides ${skills.join(" ")}`] : []),
    ...(patch.disableClaudeAiConnectors === true && connectors !== true
      ? [connectors === undefined ? "disableClaudeAiConnectors" : `disableClaudeAiConnectors (était ${JSON.stringify(connectors)})`]
      : []),
  ];
}
