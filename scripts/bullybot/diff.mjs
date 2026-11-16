/**
 * Files that are just noise in a review (lockfiles, binaries, build output).
 * They would eat the context budget without containing anything worth reviewing.
 */
const NOISE = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  /\.(png|jpe?g|gif|ico|webp|avif|svg|woff2?|ttf|otf|eot|pdf|zip|gz)$/i,
  /(^|\/)(dist|coverage|\.angular)\//,
  /\.min\.(js|css)$/,
];

export const isNoise = (path) => NOISE.some((re) => re.test(path));

export const isTestFile = (path) =>
  /\.(spec|test)\.[cm]?[jt]sx?$/.test(path) || /(^|\/)(e2e|__tests__)\//.test(path);

/**
 * Splits the diff per file and annotates the lines of the new file with line numbers.
 * `valid` holds all lines (RIGHT side) GitHub accepts inline comments on.
 */
export function parseDiff(diff) {
  const files = new Map();
  let cur = null;
  let inHunk = false;
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = line.match(/ b\/(.+)$/)?.[1];
      cur = { path, raw: [line], annotated: [line], valid: new Set() };
      files.set(path, cur);
      inHunk = false;
      continue;
    }
    if (!cur || line === '') continue;

    cur.raw.push(line);
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      cur.annotated.push(line);
    } else if (!inHunk || line.startsWith('\\')) {
      cur.annotated.push(line);
    } else if (line.startsWith('-')) {
      cur.annotated.push(`     | ${line}`);
    } else {
      cur.valid.add(newLine);
      cur.annotated.push(`L${newLine}| ${line}`);
      newLine++;
    }
  }
  return files;
}

/**
 * Finds existing test files for changed source files (foo.ts -> foo.spec.ts / foo.test.ts)
 * that are not part of the diff themselves, so the model can judge whether existing tests cover the behavior.
 */
export function findRelatedTests(changedPaths, allPaths) {
  const all = new Set(allPaths);
  const changed = new Set(changedPaths);
  const related = new Set();

  for (const path of changedPaths) {
    if (isTestFile(path)) continue;
    const m = path.match(/^(.*)\.([cm]?[jt]sx?)$/);
    if (!m) continue;
    const [, base, ext] = m;
    for (const kind of ['spec', 'test']) {
      for (const e of new Set([ext, 'ts', 'js', 'mjs'])) {
        const candidate = `${base}.${kind}.${e}`;
        if (all.has(candidate) && !changed.has(candidate)) related.add(candidate);
      }
    }
  }
  return [...related];
}
