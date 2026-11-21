// Finding the project that opted in, and where its prompt files go (SPEC.md section 2).

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.open-prompts.json';
export const DEFAULT_DIR = 'prompts';

/** Redaction options of the reference implementation, with their defaults (see README). */
export const REDACT_DEFAULTS = { emails: false, homePaths: true };

/**
 * Checks the optional "redact" object. Unknown keys are ignored, as producers must ignore
 * fields they do not know (SPEC.md section 2), but known keys must have the right type.
 */
function readRedactOptions(value, configPath) {
  if (value === undefined) return { ...REDACT_DEFAULTS };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${configPath}: "redact" must be an object, such as { "emails": true }`);
  }
  const options = { ...REDACT_DEFAULTS };
  for (const key of Object.keys(REDACT_DEFAULTS)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'boolean') throw new Error(`${configPath}: "redact.${key}" must be true or false`);
    options[key] = value[key];
  }
  return options;
}

/**
 * Checks the optional "ignore" list: regular expressions, as strings, matched against the
 * cleaned prompt. A string written as `/pattern/flags` keeps its flags, such as `i`.
 * Returns the compiled expressions.
 */
function readIgnore(value, configPath) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${configPath}: "ignore" must be a list of regular expressions, such as ["^wip$"]`);
  return value.map((source, index) => {
    if (typeof source !== 'string' || source === '') throw new Error(`${configPath}: "ignore[${index}]" must be a non-empty string`);
    const literal = /^\/(.+)\/([a-z]*)$/s.exec(source);
    try {
      // "g" and "y" would make test() remember where it stopped, so they are dropped.
      return literal ? new RegExp(literal[1], literal[2].replace(/[gy]/g, '')) : new RegExp(source);
    } catch (error) {
      throw new Error(`${configPath}: "ignore[${index}]" is not a valid regular expression: ${error.message}`);
    }
  });
}

/** Checks the optional "ignoreCommands" list of slash commands, such as ["/clear", "/compact"]. */
function readIgnoreCommands(value, configPath) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${configPath}: "ignoreCommands" must be a list of slash commands, such as ["/clear"]`);
  return value.map((command, index) => {
    if (typeof command !== 'string' || !/^\/[^\s/][^\s]*$/.test(command)) {
      throw new Error(`${configPath}: "ignoreCommands[${index}]" must be a slash command without spaces, such as "/clear"`);
    }
    return command;
  });
}

/** Checks the optional "spool" switch: false keeps the records of this repository out of the local spool. */
function readSpoolOption(value, configPath) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error(`${configPath}: "spool" must be true or false`);
  return value;
}

/** The smallest "maxPasteLength": below it, the marker would take most of the room. */
export const MIN_PASTE_LENGTH = 100;

/**
 * Checks the optional "maxPasteLength": the length, in characters, above which a pasted
 * block is shortened (see paste.mjs). Off (null) unless the repository sets it.
 */
function readMaxPasteLength(value, configPath) {
  if (value === undefined || value === null || value === false) return null;
  if (!Number.isInteger(value) || value < MIN_PASTE_LENGTH) {
    throw new Error(`${configPath}: "maxPasteLength" must be a whole number of characters, ${MIN_PASTE_LENGTH} or more, or false to keep pasted text whole`);
  }
  return value;
}

/**
 * Reads and checks a `.open-prompts.json`. Throws with a readable message when it is invalid.
 * Returns the known fields with their defaults filled in; other fields are ignored.
 */
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
  return {
    version: 1,
    dir,
    redact: readRedactOptions(config.redact, configPath),
    ignore: readIgnore(config.ignore, configPath),
    ignoreCommands: readIgnoreCommands(config.ignoreCommands, configPath),
    spool: readSpoolOption(config.spool, configPath),
    maxPasteLength: readMaxPasteLength(config.maxPasteLength, configPath),
  };
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
