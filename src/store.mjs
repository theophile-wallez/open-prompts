// Prompt files: one append-only JSONL file per session (SPEC.md section 3).

import fs from 'node:fs';
import path from 'node:path';
import { FILE_NAME_RE } from './record.mjs';

const sanitize = (value) => value.replace(/[^A-Za-z0-9_-]/g, '-');

function firstSession(file) {
  try {
    const firstLine = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    return JSON.parse(firstLine).session;
  } catch {
    return undefined;
  }
}

/** Finds the file of `session` in `dir`, or picks the name of a new one. */
export function sessionFile(dir, session, timestamp) {
  const shortKey = sanitize(session.slice(0, 8));
  const fullKey = sanitize(session);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => FILE_NAME_RE.test(name)) : [];

  let shortKeyTaken = false;
  for (const key of new Set([shortKey, fullKey])) {
    for (const name of names.filter((n) => n.slice(11) === `${key}.jsonl`)) {
      const file = path.join(dir, name);
      if (firstSession(file) === session) return file;
      if (key === shortKey) shortKeyTaken = true;
    }
  }
  const date = new Date(timestamp).toISOString().slice(0, 10);
  return path.join(dir, `${date}-${shortKeyTaken ? fullKey : shortKey}.jsonl`);
}

/**
 * Appends `record` to its session file, unless a record with the same `id` is already there.
 * Returns { file, written }.
 */
export function appendRecord(dir, record, { dryRun = false } = {}) {
  if (!dryRun) fs.mkdirSync(dir, { recursive: true });
  const file = sessionFile(dir, record.session, record.timestamp);
  if (record.id && fs.existsSync(file)) {
    const needle = `"id":${JSON.stringify(record.id)}`;
    if (fs.readFileSync(file, 'utf8').includes(needle)) return { file, written: false };
  }
  if (!dryRun) fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return { file, written: true };
}

/** Reads the records of a file, skipping lines that are not JSON. */
export function readRecords(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** Lists the prompt files of a directory, oldest first. */
export function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Replaces line `index` (0-based) of `file` with `replacement`, or removes it when `replacement` is null,
 * but only if the line still reads `expected`. Removing the last line removes the file.
 * Returns true on success, false when the line changed since it was read.
 */
export function rewriteLine(file, index, expected, replacement) {
  const before = fs.readFileSync(file, 'utf8');
  const lines = before.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[index] !== expected) return false;
  if (replacement === null) lines.splice(index, 1);
  else lines[index] = replacement;
  if (lines.length === 0) {
    fs.rmSync(file);
    return true;
  }
  // Write next to the file and rename, so a reader never sees half a file. If a hook appended
  // a line in the meantime, start again rather than lose it.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${lines.join('\n')}\n`, 'utf8');
  if (fs.readFileSync(file, 'utf8') !== before) {
    fs.rmSync(temp, { force: true });
    return rewriteLine(file, index, expected, replacement);
  }
  fs.renameSync(temp, file);
  return true;
}
