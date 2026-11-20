// Finds the icon of a project, the way T3 Code does: an `iconPath` in t3.json, then well-known
// favicon and logo files, then the `<link rel="icon">` of the app's HTML or root route. On top of
// that, the icons that browser extensions and web app manifests declare.

import fs from 'node:fs';
import path from 'node:path';

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const SOURCE_SCAN_BYTES = 128 * 1024;

export const ICON_TYPES = {
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

const CANDIDATES = [
  'favicon.svg',
  'favicon.ico',
  'favicon.png',
  'public/favicon.svg',
  'public/favicon.ico',
  'public/favicon.png',
  'app/favicon.ico',
  'app/favicon.png',
  'app/icon.svg',
  'app/icon.png',
  'app/icon.ico',
  'src/favicon.ico',
  'src/favicon.svg',
  'src/app/favicon.ico',
  'src/app/icon.svg',
  'src/app/icon.png',
  'assets/icon.svg',
  'assets/icon.png',
  'assets/logo.svg',
  'assets/logo.png',
  '.idea/icon.svg',
  // Browser extensions: the conventional places for the 128px toolbar icon.
  'public/icons/icon128.png',
  'public/icon/128.png',
  'icons/icon128.png',
  'images/icon-128.png',
];

// Files whose `<link rel="icon" href="…">` (or `{ rel: 'icon', href: '…' }`) names the icon.
const ICON_SOURCES = ['index.html', 'public/index.html', 'app/routes/__root.tsx', 'src/routes/__root.tsx', 'app/root.tsx', 'src/root.tsx', 'src/index.html'];

// Web app and extension manifests, whose `icons` list the icon at several sizes.
const MANIFESTS = ['manifest.json', 'public/manifest.json', 'src/manifest.json', 'public/manifest.webmanifest', 'public/site.webmanifest', 'site.webmanifest'];

const HTML_LINK_RE = /<link\b[^<>]*>/gi;
const HTML_ICON_REL_RE = /\brel=["'](?:icon|shortcut icon)["']/i;
const HTML_ICON_HREF_RE = /\bhref=["']([^"'?#]+)/i;
const OBJECT_ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const OBJECT_ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?#]+)/i;

/** The real path of `relative` inside `root`, if it is a file there that a browser can show. */
function existingIcon(root, relative) {
  if (typeof relative !== 'string' || relative.trim() === '' || /^[a-z]+:/i.test(relative)) return null;
  if (!ICON_TYPES[path.extname(relative).toLowerCase()]) return null;
  try {
    const file = fs.realpathSync(path.resolve(root, relative.trim()));
    if (file !== root && !file.startsWith(root + path.sep)) return null;
    const stats = fs.statSync(file);
    return stats.isFile() && stats.size > 0 && stats.size <= MAX_ICON_BYTES ? file : null;
  } catch {
    return null;
  }
}

function readStart(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, bytes, 0)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function extractIconHref(source) {
  for (const [tag] of source.matchAll(HTML_LINK_RE)) {
    if (!HTML_ICON_REL_RE.test(tag)) continue;
    const href = tag.match(HTML_ICON_HREF_RE)?.[1];
    if (href) return href;
  }
  for (const run of source.split('}')) {
    if (!OBJECT_ICON_REL_RE.test(run)) continue;
    const href = run.match(OBJECT_ICON_HREF_RE)?.[1];
    if (href) return href;
  }
  return null;
}

/** The largest icon a manifest declares: `{ "128": "icons/a.png" }` (extensions) or `[{ src, sizes }]` (web apps). */
function manifestIcon(root, manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readStart(path.join(root, manifestPath), SOURCE_SCAN_BYTES) ?? '');
  } catch {
    return null;
  }
  const icons = manifest?.icons;
  let entries = [];
  if (Array.isArray(icons)) {
    entries = icons.map((icon) => [Math.max(0, ...String(icon?.sizes ?? '').split(/\s+/).map((size) => parseInt(size, 10) || 0)), icon?.src]);
  } else if (icons && typeof icons === 'object') {
    entries = Object.entries(icons).map(([size, src]) => [parseInt(size, 10) || 0, src]);
  }
  const dir = path.dirname(manifestPath);
  for (const [, src] of entries.sort((a, b) => b[0] - a[0])) {
    if (typeof src !== 'string') continue;
    const clean = src.replace(/^\//, '');
    // Paths are relative to the manifest; built extensions copy public/ to their root.
    const found = existingIcon(root, path.join(dir, clean)) ?? existingIcon(root, path.join('public', clean)) ?? existingIcon(root, clean);
    if (found) return found;
  }
  return null;
}

/** The absolute path of the project's icon, or null when it has none. */
export function findProjectIcon(projectRoot) {
  let root;
  try {
    root = fs.realpathSync(projectRoot);
  } catch {
    return null;
  }
  try {
    const t3 = JSON.parse(readStart(path.join(root, 't3.json'), SOURCE_SCAN_BYTES) ?? '');
    const found = existingIcon(root, t3?.iconPath);
    if (found) return found;
  } catch {
    // No t3.json, or not one we can read.
  }
  for (const candidate of CANDIDATES) {
    const found = existingIcon(root, candidate);
    if (found) return found;
  }
  for (const source of ICON_SOURCES) {
    const text = readStart(path.join(root, source), SOURCE_SCAN_BYTES);
    const href = text && extractIconHref(text);
    if (!href) continue;
    const clean = href.trim().replace(/^\//, '');
    const found = existingIcon(root, path.join('public', clean)) ?? existingIcon(root, clean);
    if (found) return found;
  }
  for (const manifest of MANIFESTS) {
    const found = manifestIcon(root, manifest);
    if (found) return found;
  }
  return null;
}
