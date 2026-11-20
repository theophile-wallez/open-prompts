// Finding the project that opted in, and where its prompt files go (SPEC.md section 2).

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.open-prompts.json';
export const DEFAULT_DIR = 'prompts';

/** Reads and checks a `.open-prompts.json`. Throws with a readable message when it is invalid. */
export function readConfig(configPath) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`${configPath} is not valid JSON: ${error.message}`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  if (config.version !== 1) throw new Error(`${configPath}: "version" must be 1`);
  const dir = config.dir ?? DEFAULT_DIR;
  if (typeof dir !== 'string' || dir.trim() === '') throw new Error(`${configPath}: "dir" must be a non-empty string`);
  if (path.posix.isAbsolute(dir) || path.win32.isAbsolute(dir) || dir.split(/[\\/]/).includes('..')) {
    throw new Error(`${configPath}: "dir" must be a relative path without ".."`);
  }
  return { version: 1, dir };
}

/**
 * Looks for `.open-prompts.json` in `start` and its parents.
 * Returns { root, configPath, config, promptsDir } or null when no project opted in.
 */
export function findProject(start) {
  let dir = path.resolve(start);
  for (;;) {
    const configPath = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(configPath)) {
      const config = readConfig(configPath);
      return { root: dir, configPath, config, promptsDir: path.join(dir, ...config.dir.split(/[\\/]/)) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
