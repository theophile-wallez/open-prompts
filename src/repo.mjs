// Which directories belong to a repository. Agents store their sessions by working
// directory, and one repository can have many: the main checkout, its subdirectories, git
// worktrees (often one per task, deleted once merged), other clones. `import` uses this to
// find every session of the repository, from what each source says about a directory.
//
// Evidence is either strong or weak:
// - strong: the directory is the checkout or inside it; it is listed by `git worktree
//   list`; it exists and git says it shares the repository's git directory or root commit;
//   or T3 Code says it is a worktree of one of the repository's T3 projects.
// - weak: the directory is gone and its path only looks like a worktree of a repository with
//   the same name (`…/worktrees/<name>/…`). Two repositories can share a name, so a weak
//   match is used only when nothing contradicts it: the directory does not exist as part of
//   another repository, and T3 Code does not place it in another project.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Runs git in `dir`. Returns its trimmed output, or null when git fails or is missing. */
function git(dir, args) {
  try {
    const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

/** The real path of `file`, or its resolved path when it does not exist. */
export function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Whether `child` is `parent` or inside it. */
export const isInside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Writes the home directory as ~, to keep the paths `import` prints short. */
export const tildify = (file) => {
  const home = os.homedir();
  return typeof file === 'string' && isInside(file, home) ? `~${file.slice(home.length)}` : file;
};

/**
 * The git directory shared by all worktrees of the repository that holds `dir`, or null.
 * Read from the files git keeps (`.git`, `gitdir:`, `commondir`), without running git,
 * because `import` asks this for hundreds of directories.
 */
export function commonDir(dir) {
  for (let current = realPath(dir); ; current = path.dirname(current)) {
    const dotGit = path.join(current, '.git');
    let gitDir = null;
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) gitDir = dotGit;
      else {
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
        if (pointer) gitDir = path.resolve(current, pointer);
      }
    } catch {
      // No .git here: keep walking up.
    }
    if (gitDir) {
      try {
        return realPath(path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()));
      } catch {
        return realPath(gitDir);
      }
    }
    if (path.dirname(current) === current) return null;
  }
}

const rootCommits = (dir) => new Set((git(dir, ['rev-list', '--max-parents=0', 'HEAD']) ?? '').split('\n').filter(Boolean));

/** Whether the repository at `dir` holds one of `commits`, that is, shares their history. */
const holdsAny = (dir, commits) => [...commits].some((commit) => git(dir, ['cat-file', '-e', `${commit}^{commit}`]) !== null);

/**
 * What identifies the repository at `root`: its real path, git directory, root commits,
 * worktrees and name. Without git, only the path is known.
 */
export function repositoryIdentity(root) {
  const realRoot = realPath(root);
  const common = git(realRoot, ['rev-parse', '--git-common-dir']) !== null ? commonDir(realRoot) : null;
  const identity = { root: realRoot, commonDir: common, rootCommits: new Set(), worktrees: [realRoot], names: [path.basename(realRoot)], firstCommit: null };
  if (!common) return identity;
  identity.rootCommits = rootCommits(realRoot);
  const listed = (git(realRoot, ['worktree', 'list', '--porcelain']) ?? '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => realPath(line.slice('worktree '.length)));
  identity.worktrees = [...new Set([realRoot, ...listed])];
  // The main checkout holds the git directory; worktrees are often named after it.
  const main = path.basename(common) === '.git' ? path.dirname(common) : common.replace(/\.git$/, '');
  identity.names = [path.basename(main)];
  const dates = [...identity.rootCommits].map((commit) => git(realRoot, ['log', '-1', '--format=%cI', commit])).filter(Boolean);
  identity.firstCommit = dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return identity;
}

/**
 * Whether a gone directory's path looks like a worktree of a repository named `name`:
 * `…/worktrees/<name>/<worktree>/…` (T3 Code and similar tools) or
 * `…/worktrees/<id>/<name>/…` (Codex).
 */
export function looksLikeWorktreeOf(dir, names) {
  const parts = dir.split(/[\\/]/);
  return parts.some((part, i) => {
    if (part !== 'worktrees' && part !== '.worktrees') return false;
    const [first, second] = parts.slice(i + 1);
    return names.some((name) => (first === name && second !== undefined && second !== '') || second === name);
  });
}

/**
 * Builds the matcher of a repository. `match(dir)` returns
 * { strength: 'strong' | 'weak' | null, reason } for a working directory, where `reason`
 * says, in plain words, why it belongs to the repository or why not.
 *
 * `hostPaths` holds what a host such as T3 Code knows about directories: a map from a
 * real path to { mine, label }, where `mine` tells whether it belongs to this repository.
 */
export function repositoryMatcher(identity, { hostPaths = new Map() } = {}) {
  const cache = new Map();
  const sharesHistory = new Map();
  const decide = (dir) => {
    if (typeof dir !== 'string' || dir === '') return { strength: null, reason: 'no working directory' };
    const real = realPath(dir);
    if (isInside(real, identity.root)) return { strength: 'strong', reason: real === identity.root ? 'this checkout' : 'inside this checkout' };
    const worktree = identity.worktrees.find((tree) => isInside(real, tree));
    if (worktree) return { strength: 'strong', reason: `worktree of this repository (git worktree list: ${tildify(worktree)})` };
    const exists = fs.existsSync(real);
    const weak = !exists && looksLikeWorktreeOf(real, identity.names);
    const weakReason = `the directory is gone, and its path looks like a worktree of ${identity.names.join(' or ')}`;
    // Not the weak guess, because something says otherwise.
    const against = (reason) => ({ strength: null, reason: weak ? `weak match (${weakReason}) contradicted: ${reason}` : reason, contradicted: weak });
    if (exists) {
      const common = commonDir(real);
      if (common && common === identity.commonDir) return { strength: 'strong', reason: 'same git repository (git directory)' };
      if (common && identity.rootCommits.size > 0) {
        if (!sharesHistory.has(common)) sharesHistory.set(common, holdsAny(real, identity.rootCommits));
        if (sharesHistory.get(common)) return { strength: 'strong', reason: 'same root commit (another clone of this repository)' };
      }
      if (common) return { strength: null, reason: 'another git repository' };
    }
    const host = [...hostPaths].filter(([known]) => isInside(real, known)).sort(([a], [b]) => b.length - a.length)[0]?.[1];
    if (host) return host.mine ? { strength: 'strong', reason: host.label } : against(host.label);
    if (weak) return { strength: 'weak', reason: `weak: ${weakReason}` };
    return { strength: null, reason: 'not this repository' };
  };
  return (dir) => {
    if (!cache.has(dir)) cache.set(dir, decide(dir));
    return cache.get(dir);
  };
}
