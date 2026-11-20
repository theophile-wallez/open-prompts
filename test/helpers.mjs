import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
