// A local copy of the records the hooks write, kept in the state directory, outside every
// repository. A session that ships nothing leaves its prompt file untracked in its checkout,
// and when that checkout is a worktree that gets deleted, the prompts would be lost.
// `open-prompts collect` adds the records of the repository that a checkout is missing.
//
// Records are grouped by repository: one directory per git common directory (shared by the
// main checkout and all its worktrees), named after a hash of its real path, with one file
// per session. Only repositories that opted in get one, because only their records exist.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE } from './project.mjs';
import { validateRecord } from './record.mjs';
import { commonDir, realPath } from './repo.mjs';
import { appendRecord, listFiles, readRecords, rewriteLine, sessionFile } from './store.mjs';
import { logError, stateDir } from './state.mjs';

/** Spooled sessions that have not been written to for this long are removed. */
export const SPOOL_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const sanitize = (value) => value.replace(/[^A-Za-z0-9_-]/g, '-');

/** Where the spool lives: `spool/` in the state directory. */
export const spoolRoot = (env = process.env) => path.join(stateDir(env), 'spool');

/**
 * What identifies the repository of a checkout: the real path of its git common directory,
 * read from `.git` without running git, or the real path of the project root without git.
 */
export function repositoryId(root) {
  return commonDir(root) ?? realPath(root);
}

const spoolDirFor = (id, env) => path.join(spoolRoot(env), crypto.createHash('sha256').update(id).digest('hex').slice(0, 16));

/** The spool directory of the repository that holds `project`. */
export const spoolDirOf = (project, env = process.env) => spoolDirFor(repositoryId(project.root), env);

/** Whether records of `project` go to the spool: on unless "spool": false or OPEN_PROMPTS_SPOOL=off. */
export function spoolEnabled(project, env = process.env) {
  if (['off', '0', 'false'].includes(String(env.OPEN_PROMPTS_SPOOL ?? '').toLowerCase())) return false;
  return project?.config?.spool !== false;
}

/**
 * Appends a record the hooks just wrote to the spool of its repository, with the checkout
 * it was written in. Never throws: the record is already in the working tree, and the
 * spool is only a safety net.
 */
export function spoolRecord(project, record, env = process.env) {
  if (!spoolEnabled(project, env)) return;
  try {
    const id = repositoryId(project.root);
    const dir = spoolDirFor(id, env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Says which repository the directory is for, to a person looking at the spool.
    const about = path.join(dir, 'repository.json');
    if (!fs.existsSync(about)) fs.writeFileSync(about, `${JSON.stringify({ repository: id })}\n`, { mode: 0o600 });
    const line = JSON.stringify({ checkout: realPath(project.root), record });
    fs.appendFileSync(path.join(dir, `${sanitize(record.session)}.jsonl`), `${line}\n`, { mode: 0o600 });
    pruneSpoolDaily(env);
  } catch (error) {
    logError(stateDir(env), error);
  }
}

/**
 * Removes spooled sessions not written to for `SPOOL_MAX_AGE_DAYS`, and repositories left
 * with none. Returns how many session files were removed.
 */
export function pruneSpool(env = process.env, now = Date.now()) {
  const root = spoolRoot(env);
  let removed = 0;
  let repos;
  try {
    repos = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return 0;
  }
  for (const repo of repos) {
    const dir = path.join(root, repo.name);
    try {
      let left = 0;
      for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
        const file = path.join(dir, name);
        if (now - fs.statSync(file).mtimeMs > SPOOL_MAX_AGE_DAYS * DAY_MS) {
          fs.rmSync(file, { force: true });
          removed++;
        } else left++;
      }
      if (left === 0) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Another process may be pruning too.
    }
  }
  return removed;
}

/** Prunes at most once a day, so a hook pays for one `stat` most of the time. */
function pruneSpoolDaily(env, now = Date.now()) {
  const marker = path.join(spoolRoot(env), '.pruned');
  try {
    if (now - fs.statSync(marker).mtimeMs < DAY_MS) return;
  } catch {
    // Never pruned yet.
  }
  pruneSpool(env, now);
  fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(marker, '');
}

/**
 * The records in the spool of `project`'s repository, oldest first, as [{ checkout, record }].
 * Lines that are not valid records are counted in `invalid`.
 */
export function readSpool(project, env = process.env) {
  const dir = spoolDirOf(project, env);
  const entries = [];
  let invalid = 0;
  for (const file of listFiles(dir)) {
    for (const line of readRecords(file)) {
      const { checkout, record } = line ?? {};
      if (typeof checkout === 'string' && validateRecord(record).length === 0) entries.push({ checkout, record });
      else invalid++;
    }
  }
  entries.sort((a, b) => Date.parse(a.record.timestamp) - Date.parse(b.record.timestamp));
  return { dir, entries, invalid };
}

/**
 * How two copies of a record are recognized: by the agent's ID, or, without one, by the
 * session and the time. Not by the text, so a line a person edited by hand, for example to
 * remove a secret, is not added again in its first form.
 */
export const recordKey = (record) => (record.id ? `id\u0000${record.session}\u0000${record.id}` : `at\u0000${record.session}\u0000${record.timestamp}`);

/**
 * The prompt files, relative to the project root with `/`, that a commit of any branch
 * added, including files deleted since. Empty without git.
 */
function committedFiles(project) {
  try {
    const result = spawnSync('git', ['log', '--all', '--relative', '--format=', '--name-only', '--diff-filter=A', '--', project.config.dir], {
      cwd: project.root,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(result.status === 0 ? result.stdout.split('\n').filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

/**
 * Adds to the prompt files of `project` every spooled record of its repository that they
 * are missing, each in the file of its session. With `dryRun`, writes nothing.
 *
 * Two kinds of missing records are left out, because adding them here would stop git from
 * bringing in their file later ("untracked working tree files would be overwritten"):
 * - records of another checkout that still exists, such as a live worktree: they are there;
 * - sessions whose file would be new here but is in git already, in a branch not merged
 *   yet or deleted from the history on purpose.
 *
 * Returns { added, present, invalid, files, records, live, committed }, where `live` maps a
 * checkout to its number of records left out, and `committed` a file to its number.
 */
export function collect(project, { dryRun = false, env = process.env } = {}) {
  pruneSpool(env);
  const { entries, invalid } = readSpool(project, env);
  const known = new Set();
  for (const file of listFiles(project.promptsDir)) for (const record of readRecords(file)) known.add(recordKey(record));
  const here = realPath(project.root);
  const repository = repositoryId(project.root);
  const alive = new Map();
  const isAlive = (checkout) => {
    if (!alive.has(checkout)) alive.set(checkout, fs.existsSync(path.join(checkout, CONFIG_FILE)) && repositoryId(checkout) === repository);
    return alive.get(checkout);
  };
  let present = 0;
  const live = new Map();
  const missing = [];
  for (const { checkout, record } of entries) {
    const key = recordKey(record);
    if (known.has(key)) present++;
    else if (checkout !== here && isAlive(checkout)) live.set(checkout, (live.get(checkout) ?? 0) + 1);
    else {
      known.add(key);
      missing.push(record);
    }
  }
  // Session by session, so the records of each one are appended in the order they were typed.
  let inGit = null;
  const committed = new Map();
  const files = new Set();
  const added = [];
  for (const records of groupBy(missing, (record) => record.session).values()) {
    const target = sessionFile(project.promptsDir, records[0].session, records[0].timestamp);
    if (!fs.existsSync(target)) {
      inGit ??= committedFiles(project);
      const name = path.relative(project.root, target).split(path.sep).join('/');
      if (inGit.has(name)) {
        committed.set(target, records.length);
        continue;
      }
    }
    files.add(target);
    for (const record of records) {
      // In a dry run, the file of a new session is not created, so it keeps the name of the first record.
      added.push({ file: dryRun ? target : appendRecord(project.promptsDir, record).file, record });
    }
  }
  return { added: added.length, present, invalid, files: [...files], records: added, live, committed };
}

/** Groups `items` by `keyOf(item)`, keeping their order. */
function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/**
 * Applies a change a person made to a recorded prompt to its spooled copy, so that
 * `collect` does not bring back what they removed: `replacement` is the new record, or
 * null when the record was deleted. Never throws.
 */
export function updateSpooled(project, record, replacement, env = process.env) {
  try {
    const file = path.join(spoolDirOf(project, env), `${sanitize(String(record.session))}.jsonl`);
    if (!fs.existsSync(file)) return;
    const key = recordKey(record);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      let spooled;
      try {
        spooled = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (!spooled?.record || recordKey(spooled.record) !== key) continue;
      rewriteLine(file, index, lines[index], replacement === null ? null : JSON.stringify({ ...spooled, record: replacement }));
    }
  } catch (error) {
    logError(stateDir(env), error);
  }
}
