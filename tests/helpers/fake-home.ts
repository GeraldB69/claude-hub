import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface FakeHome {
  readonly home: string;
  /** Écrit un fichier relatif à `home` en créant les dossiers manquants. */
  writeFile(relativePath: string, content: string): string;
  /** Crée un dossier relatif à `home`. */
  makeDir(relativePath: string): string;
  /** Crée un lien symbolique relatif à `home` ; `target` est écrit tel quel dans le lien. */
  symlink(relativePath: string, target: string): string;
  cleanup(): void;
}

export function createFakeHome(): FakeHome {
  const home = mkdtempSync(join(tmpdir(), "ch-home-"));
  return {
    home,
    writeFile(relativePath, content) {
      const target = join(home, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    },
    makeDir(relativePath) {
      const target = join(home, relativePath);
      mkdirSync(target, { recursive: true });
      return target;
    },
    symlink(relativePath, target) {
      const link = join(home, relativePath);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
      return link;
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
