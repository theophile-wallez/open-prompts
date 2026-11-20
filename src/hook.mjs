// Dispatches a hook event to the right agent adapter.

import * as claudeCode from './agents/claude-code.mjs';
import * as codex from './agents/codex.mjs';
import * as copilot from './agents/copilot.mjs';
import * as cursor from './agents/cursor.mjs';
import * as geminiCli from './agents/gemini-cli.mjs';

export const HOOK_ADAPTERS = {
  'claude-code': claudeCode,
  codex,
  cursor,
  'gemini-cli': geminiCli,
  copilot,
};

/**
 * Tells which agent sent a payload. Cursor and Copilot also run hooks written for
 * Claude Code, so a hook installed for Claude Code can receive their payloads.
 * Only the payload is used, never the environment, which a nested agent inherits.
 */
export function detectAgent(input) {
  if (cursor.looksLikeCursor(input)) return 'cursor';
  if ('turn_id' in input) return 'codex';
  if (input.hook_event_name === 'BeforeAgent') return 'gemini-cli';
  if (copilot.looksLikeCopilot(input)) return 'copilot';
  return 'claude-code';
}

/**
 * Runs the adapter for `input`. `agent` comes from `--agent`. When the payload clearly
 * belongs to Cursor, Cursor wins, because Cursor runs other agents' hooks too.
 * `defer(agent, payload)` starts the background step of adapters that need one.
 */
export async function runHook(input, { agent, env = process.env, now, signal, defer }) {
  const detected = detectAgent(input);
  const name = detected === 'cursor' || !HOOK_ADAPTERS[agent] ? detected : agent;
  const adapter = HOOK_ADAPTERS[name];
  let result = await adapter.handle(input, { env, now, signal });
  if (result.action === 'deferred') result = { action: 'deferred', pending: defer(name, result.payload) };
  return { agent: name, result, stdout: adapter.stdout?.(input) ?? '' };
}

export function completeDeferred(agent, payload, options) {
  const adapter = HOOK_ADAPTERS[agent];
  if (!adapter?.complete) throw new Error(`no background step for ${agent}`);
  return adapter.complete(payload, options);
}
