// Keeps the version in the plugin manifests equal to package.json.
//
//   node scripts/version.mjs sync         copy package.json's version into the manifests
//   node scripts/version.mjs check [tag]  fail if they differ, or if the tag (v1.2.3) does not match
//
// `npm version` runs `sync` through the "version" script, so a version bump updates all files
// in the same commit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFESTS = ['.claude-plugin/plugin.json', 'gemini-extension.json'];

const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const write = (file, value) => fs.writeFileSync(path.join(ROOT, file), `${JSON.stringify(value, null, 2)}\n`);

const [command, tag] = process.argv.slice(2);
const version = read('package.json').version;

if (command === 'sync') {
  for (const file of MANIFESTS) {
    const manifest = read(file);
    if (manifest.version !== version) write(file, { ...manifest, version });
  }
  console.log(`Manifests set to ${version}.`);
} else if (command === 'check') {
  const problems = MANIFESTS.filter((file) => read(file).version !== version).map(
    (file) => `${file} has version ${read(file).version}, package.json has ${version}. Run "node scripts/version.mjs sync".`,
  );
  if (tag !== undefined && tag !== `v${version}`) problems.push(`Tag ${tag} does not match package.json version ${version}.`);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`Version ${version} is consistent${tag ? ` with tag ${tag}` : ''}.`);
} else {
  console.error('Usage: node scripts/version.mjs sync | check [tag]');
  process.exit(2);
}
