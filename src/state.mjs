// Small per-session state kept outside the repository, such as the active model.
// Claude Code only reports the model on SessionStart and PostModelSwitch, so the
// UserPromptSubmit hook reads it from here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function stateDir(env = process.env) {
  if (env.OPEN_PROMPTS_STATE_DIR) return env.OPEN_PROMPTS_STATE_DIR;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'open-prompts');
  const base = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'open-prompts');
}

const stateFile = (dir, session) => path.join(dir, 'sessions', `${session.replace(/[^A-Za-z0-9_-]/g, '-')}.json`);

export function readState(dir, session) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(dir, session), 'utf8'));
  } catch {
    return {};
  }
}

export function updateState(dir, session, patch) {
  const file = stateFile(dir, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readState(dir, session) };
  for (const [key, value] of Object.entries(patch)) if (value != null) next[key] = value;
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next));
  fs.renameSync(temp, file);
  return next;
}

/** Removes state files of sessions that have not been touched for 30 days. */
export function pruneState(dir, now = Date.now()) {
  const sessions = path.join(dir, 'sessions');
  if (!fs.existsSync(sessions)) return;
  for (const name of fs.readdirSync(sessions)) {
    const file = path.join(sessions, name);
    try {
      if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.unlinkSync(file);
    } catch {
      // Another session may have removed it already.
    }
  }
}

/** Appends an error to the log in the state directory. Never throws. */
export function logError(dir, error) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'errors.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000) fs.truncateSync(file, 0);
    fs.appendFileSync(file, `${new Date().toISOString()} ${error?.stack ?? error}\n`);
  } catch {
    // Logging must never break the agent.
  }
}
