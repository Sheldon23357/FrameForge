import fs from 'node:fs/promises';
import path from 'node:path';
const visited = new Set();
const notices = [];
async function findPackage(name, from) {
  let folder = from;
  while (true) {
    const candidate = path.join(folder, 'node_modules', name);
    try {
      await fs.access(path.join(candidate, 'package.json'));
      return candidate;
    } catch {}
    const parent = path.dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
}
async function collect(name, from) {
  const folder = await findPackage(name, from);
  if (!folder || visited.has(folder)) return;
  visited.add(folder);
  const metadata = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
  let text = `${metadata.name} ${metadata.version}\nLicense: ${typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license)}\n`;
  const licenseFiles = (await fs.readdir(folder)).filter((name) =>
    /^(licen[sc]e|copying|ofl|notice)(\.|$)/i.test(name),
  );
  for (const file of licenseFiles) {
    const full = path.join(folder, file);
    if ((await fs.stat(full)).isFile()) text += `\n${file}\n${await fs.readFile(full, 'utf8')}\n`;
  }
  notices.push(text);
  for (const child of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies }))
    await collect(child, folder);
}
const root = process.cwd();
const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
for (const name of Object.keys(metadata.dependencies)) await collect(name, root);
notices.sort();
await fs.writeFile(
  'public/THIRD_PARTY_NOTICES.txt',
  `帧叙 — Third-party notices\nElectron and Chromium notices are included separately alongside the executable.\n\n${notices.join('\n' + '='.repeat(80) + '\n\n').trimEnd()}\n`,
);
console.log(`Collected notices for ${notices.length} runtime dependencies.`);
