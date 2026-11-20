// What every agent adapter shares: checking that recording applies, and writing a record.

import fs from 'node:fs';
import path from 'node:path';
import { findProject } from './project.mjs';
import { makeRecord } from './record.mjs';
import { redact } from './redact.mjs';
import { appendRecord } from './store.mjs';
import { stateDir } from './state.mjs';

/** Recording is paused with OPEN_PROMPTS=off or with `open-prompts pause`. */
export function isPaused(env = process.env) {
  if (['off', '0', 'false'].includes(String(env.OPEN_PROMPTS ?? '').toLowerCase())) return true;
  return fs.existsSync(path.join(stateDir(env), 'paused'));
}

/**
 * The project that opted in above `cwd`, or a reason why nothing should be recorded.
 * Returns { project } or { reason }.
 */
export function resolveProject(cwd, env = process.env) {
  if (isPaused(env)) return { reason: 'recording is paused' };
  if (typeof cwd !== 'string' || cwd === '') return { reason: 'no working directory' };
  const project = findProject(cwd);
  if (!project) return { reason: 'this project has not opted in' };
  return { project };
}

export const ignored = (reason) => ({ action: 'ignored', reason });

/**
 * Replaces the citation markup some hosts (such as T3 Code) add when a person quotes part
 * of a reply: each `[id]` becomes the quoted text as a Markdown quote followed by the
 * person's comment, and the JSON block, with its internal IDs, is removed.
 */
export function cleanHostMarkup(text) {
  const block = /\n*<assistant_citations>([\s\S]*?)<\/assistant_citations>\n*/;
  const match = block.exec(text);
  if (!match) return text;
  let rendered = new Map();
  try {
    const json = match[1].slice(match[1].indexOf('['), match[1].lastIndexOf(']') + 1);
    for (const { id, citation } of JSON.parse(json)) {
      const quote = String(citation?.text ?? '').trim().split('\n').map((line) => `> ${line}`).join('\n');
      rendered.set(id, [quote, citation?.comment?.trim()].filter(Boolean).join('\n\n'));
    }
  } catch {
    rendered = new Map();
  }
  return text
    .replace(block, '\n')
    .replace(/\[([A-Za-z0-9_-]+)\]/g, (token, id) => rendered.get(id) ?? token)
    .trim();
}

/** Turns a model reported by an agent into a string or null. */
export const realModel = (model) => (typeof model === 'string' && model !== '' && model !== '<synthetic>' ? model : null);

/**
 * Redacts and appends one prompt to the project's prompt files.
 * `prompt` must already be cleaned by the adapter.
 */
export function writePrompt(project, { agent, agentVersion, model, session, id, timestamp, prompt }) {
  const trimmed = typeof prompt === 'string' ? prompt.trim() : '';
  if (trimmed === '') return ignored('empty prompt');
  if (typeof session !== 'string' || session === '') return ignored('no session id');
  const { text, kinds } = redact(trimmed);
  const record = makeRecord({ id, timestamp, agent, agentVersion, model: realModel(model), session, prompt: text });
  const { file, written } = appendRecord(project.promptsDir, record);
  return { action: written ? 'recorded' : 'duplicate', file, redacted: kinds };
}

/** Parses JSON lines, skipping the ones that are not JSON. */
export function parseJsonLines(text) {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Parses the last `maxBytes` of a JSONL file. Returns [] when it cannot be read. */
export function readJsonlTail(file, maxBytes = 1 << 20) {
  if (typeof file !== 'string' || file === '') return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return parseJsonLines(start > 0 ? text.slice(text.indexOf('\n') + 1) : text);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Parses a JSONL file from byte `offset` to its end (at most `maxBytes`). */
export function readJsonlFrom(file, offset, maxBytes = 1 << 20) {
  if (typeof file !== 'string' || file === '') return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, Math.min(offset, size));
    const length = Math.min(size - start, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return parseJsonLines(buffer.toString('utf8'));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Size of a file in bytes, or 0 when it does not exist yet. */
export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** Reads the first line of a file as JSON, or returns null. */
export function readFirstJsonLine(file) {
  if (typeof file !== 'string' || file === '') return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytes).toString('utf8');
    return JSON.parse(text.split('\n', 1)[0]);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

/**
 * Calls `probe` every 300 ms until it returns a value, `waitMs` passes or `signal` aborts.
 * Returns the value or null.
 */
export async function poll(probe, { waitMs, signal }) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const value = probe();
    if (value != null || signal?.aborted || Date.now() >= deadline) return value ?? null;
    await sleep(Math.min(300, deadline - Date.now()), signal);
  }
}

/** How long adapters wait for the agent's reply to learn the model. */
export function waitMsFrom(env = process.env, fallback = 120_000) {
  const value = Number(env.OPEN_PROMPTS_WAIT_MS ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}
