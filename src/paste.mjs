// Shortening very long pasted text, when a repository asks for it with "maxPasteLength"
// in `.open-prompts.json` (SPEC.md section 5). Off by default: the spec records everything
// pasted unless the repository opts into this.
//
// A pasted block longer than the limit keeps its first and last lines, within the limit,
// and the middle becomes a marker such as `[… 412 lines omitted …]`. Shortening runs before
// redaction, so cuts are made between lines (or between words, for one long line), where
// they cannot split a token, and never inside a private key block.

const BEGIN_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const END_KEY = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** The marker that replaces what was left out. */
export const omitted = (count, unit) => `[… ${count} ${unit}${count === 1 ? '' : 's'} omitted …]`;

/** Drops the end of `head` from a private key block it opens and does not close. */
function headWithoutOpenKey(lines) {
  for (let index = lines.length - 1; index >= 0; index--) {
    if (END_KEY.test(lines[index])) return lines;
    if (BEGIN_KEY.test(lines[index])) return lines.slice(0, index);
  }
  return lines;
}

/** Drops the start of `tail` up to the end of a private key block it closes and does not open. */
function tailWithoutOpenKey(lines) {
  for (let index = 0; index < lines.length; index++) {
    if (BEGIN_KEY.test(lines[index])) return lines;
    if (END_KEY.test(lines[index])) return lines.slice(index + 1);
  }
  return lines;
}

/** Shortens a text by characters: keeps whole words at both ends. For one long line. */
function shortenLine(text, max) {
  const budget = max - omitted(text.length, 'character').length - 2;
  if (budget <= 0) return omitted(text.length, 'character');
  let head = text.slice(0, Math.floor(budget / 2));
  // Cut back to the last space, so that no word, and no token, is kept in part.
  head = /\s/.test(text[head.length] ?? ' ') ? head : head.slice(0, Math.max(0, head.search(/\s\S*$/)));
  let tail = text.slice(text.length - (budget - head.length));
  tail = /\s/.test(text[text.length - tail.length - 1] ?? ' ') ? tail : tail.slice(tail.search(/\s/) + 1 || tail.length);
  // A private key on one line is dropped whole rather than in part.
  const open = head.search(BEGIN_KEY);
  if (open >= 0 && !END_KEY.test(head.slice(open))) head = head.slice(0, open);
  const close = tail.search(END_KEY);
  if (close >= 0 && !BEGIN_KEY.test(tail.slice(0, close))) tail = tail.slice(close + (END_KEY.exec(tail)?.[0].length ?? 0));
  head = head.trimEnd();
  tail = tail.trimStart();
  const marker = omitted(text.length - head.length - tail.length, 'character');
  return [head, marker, tail].filter(Boolean).join(' ');
}

/**
 * Shortens `text` to at most `max` characters, marker included, when it is longer: keeps
 * as many first and last lines as fit, about half the room each, and replaces the lines in
 * between with `[… N lines omitted …]`. Text of one line keeps its first and last words.
 */
export function shortenPaste(text, max) {
  if (typeof text !== 'string' || !max || text.length <= max) return text;
  const lines = text.split('\n');
  if (lines.length === 1) return shortenLine(text, max);
  const room = max - omitted(lines.length, 'line').length - 2;
  let head = [];
  let used = 0;
  while (head.length < lines.length && used + lines[head.length].length + 1 <= room / 2) {
    used += lines[head.length].length + 1;
    head.push(lines[head.length]);
  }
  let tail = [];
  for (let index = lines.length - 1; index >= head.length && used + lines[index].length + 1 <= room; index--) {
    used += lines[index].length + 1;
    tail.unshift(lines[index]);
  }
  // Lines too long to keep any of them whole, such as minified code: keep words instead.
  if (head.length === 0 && tail.length === 0) return shortenLine(text, max);
  head = headWithoutOpenKey(head);
  tail = tailWithoutOpenKey(tail);
  const marker = omitted(lines.length - head.length - tail.length, 'line');
  return [...head, marker, ...tail].join('\n');
}

/**
 * Applies a "maxPasteLength" limit to a cleaned prompt. `pastes` lists the pasted blocks
 * the agent marked, as they appear in `prompt`: each one longer than `max` is shortened,
 * and the text typed around them is kept. Without `pastes`, when the agent marks no paste,
 * the whole prompt is shortened if it is longer than `max`.
 * Returns { text, shortened }, where `shortened` counts the blocks that were shortened.
 */
export function limitPastes(prompt, pastes, max) {
  if (!max || typeof prompt !== 'string') return { text: prompt, shortened: 0 };
  if (!Array.isArray(pastes)) {
    const text = shortenPaste(prompt, max);
    return { text, shortened: text === prompt ? 0 : 1 };
  }
  let text = '';
  let from = 0;
  let shortened = 0;
  for (const paste of pastes) {
    if (typeof paste !== 'string' || paste.length <= max) continue;
    // cleanPrompt trims the prompt, so a block at either end may have lost its outer spaces.
    let block = paste;
    let index = prompt.indexOf(block, from);
    if (index < 0) index = prompt.indexOf((block = paste.trim()), from);
    if (index < 0 || block.length <= max) continue;
    text += prompt.slice(from, index) + shortenPaste(block, max);
    from = index + block.length;
    shortened++;
  }
  return { text: text + prompt.slice(from), shortened };
}
