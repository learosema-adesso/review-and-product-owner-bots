import { isNoise, isTestFile } from '../bullybot/diff.mjs';

/** Directories that usually hold the app: single project, Angular workspace, monorepo. */
export const DEFAULT_SOURCE_DIRS = ['src', 'projects', 'packages'];

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|css|scss|html|vue|svelte)$/;

/**
 * Reads the list of directories from PRODUCT_SOURCE_PATHS (comma or line separated).
 * Entries that are empty, absolute or try to leave the repository are ignored. "." stands for the
 * whole repository.
 */
export function parseSourceDirs(value) {
  return String(value ?? '')
    .split(/[,\n]/)
    .map(
      (s) =>
        s
          .trim()
          .replace(/^(\.\/)+/, '')
          .replace(/\/+$/, '') || (s.trim() ? '.' : ''),
    )
    .filter((s) => s && !s.startsWith('/') && !s.split('/').includes('..'));
}

const inDir = (path, dir) => path.startsWith(`${dir}/`);

/**
 * Picks the directories to read the source from. A configured list wins. Without one, every
 * default directory that holds source files counts. Returns null when there is none: then the
 * whole repository is used.
 */
export function detectSourceDirs(tree, configured = []) {
  // "." means the whole repository
  if (configured.includes('.')) return null;
  if (configured.length) return configured;
  const found = DEFAULT_SOURCE_DIRS.filter((dir) =>
    tree.some((p) => inDir(p, dir) && SOURCE_FILE.test(p)),
  );
  return found.length ? found : null;
}

/** Source files that show what the product can do: components, routes, services, templates. */
export function selectSourceFiles(tree, dirs) {
  return tree.filter(
    (p) =>
      SOURCE_FILE.test(p) &&
      (!dirs || dirs.some((dir) => inDir(p, dir))) &&
      !isTestFile(p) &&
      !isNoise(p),
  );
}
