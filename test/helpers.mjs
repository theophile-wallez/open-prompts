import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests may run inside T3 Code, whose sessions have T3CODE_THREAD_ID set. Hooks would then
// read T3's real database, so tests never inherit it, nor the path of that database.
delete process.env.T3CODE_THREAD_ID;
process.env.OPEN_PROMPTS_T3_DB = path.join(os.tmpdir(), 'open-prompts-test-no-t3-database.sqlite');
// The same for the session stores `import` reads: tests that need one point to a temporary one.
const NO_SOURCE = path.join(os.tmpdir(), 'open-prompts-test-no-source');
process.env.CLAUDE_CONFIG_DIR = path.join(NO_SOURCE, 'claude');
process.env.CODEX_HOME = path.join(NO_SOURCE, 'codex');
process.env.GEMINI_CLI_HOME = path.join(NO_SOURCE, 'gemini');
// Every other agent's configuration is found from the home directory, so tests get an
// empty one: `status` and `install` never read or change the user's own.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'open-prompts-test-home-'));
Object.assign(process.env, {
  HOME,
  USERPROFILE: HOME,
  XDG_CONFIG_HOME: path.join(HOME, '.config'),
  XDG_DATA_HOME: path.join(HOME, '.local', 'share'),
  COPILOT_HOME: path.join(HOME, '.copilot'),
  VIBE_HOME: path.join(HOME, '.vibe'),
  OPENCODE_CONFIG_DIR: path.join(HOME, '.config', 'opencode'),
});
// The state directory (where the hooks keep the spool) and the data directory (where
// `install` copies the runtime) default to the user's own: tests get temporary ones.
process.env.OPEN_PROMPTS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'open-prompts-test-state-'));
process.env.OPEN_PROMPTS_DATA_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'open-prompts-test-data-')), 'runtime');

export function tempDir(prefix = 'open-prompts-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A repository that opted in, plus an isolated state directory. */
export function optedInRepo() {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.open-prompts.json'), JSON.stringify({ version: 1, dir: 'prompts' }));
  const state = tempDir('open-prompts-state-');
  const env = { OPEN_PROMPTS_STATE_DIR: state, AI_AGENT: 'claude-code_2-1-328_agent' };
  return { root, state, env, promptsDir: path.join(root, 'prompts') };
}

export const readJsonl = (file) =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/**
 * Imports one session file into `project`, as `open-prompts import <file>` does: finds its
 * prompts, leaves out those already there, and writes the rest. Returns counts and records.
 */
export async function importFile(project, file, { dryRun = false } = {}) {
  const { planImport } = await import('../src/backfill.mjs');
  const { writePrompt } = await import('../src/core.mjs');
  const plan = await planImport(project, { files: [file], targets: [] });
  const result = { written: 0, skipped: plan.duplicates, ignored: 0, files: [], records: [] };
  for (const candidate of plan.write) {
    const written = writePrompt(project, candidate, { dryRun, spool: false });
    if (written.file && !result.files.includes(written.file)) result.files.push(written.file);
    if (written.action === 'recorded') {
      result.written++;
      result.records.push(written.record);
    } else if (written.action === 'duplicate') result.skipped++;
    else result.ignored++;
  }
  return result;
}
