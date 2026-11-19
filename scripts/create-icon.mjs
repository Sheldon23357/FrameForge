import fs from 'node:fs/promises';
import sharp from 'sharp';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilmStrip } from '@phosphor-icons/react';
await fs.mkdir('build', { recursive: true });
const glyph = renderToStaticMarkup(
  React.createElement(FilmStrip, { size: 164, color: '#f2f2f2', weight: 'duotone' }),
);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="54" fill="#282828"/><rect x="14" y="14" width="228" height="228" rx="43" fill="none" stroke="#626262" stroke-width="3"/><g transform="translate(46 46)">${glyph}</g></svg>`;
const icon = await sharp(Buffer.from(svg)).png().toBuffer();
await fs.writeFile('public/app-icon.png', icon);
const sizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(
  sizes.map((size) => sharp(icon).resize(size, size).png().toBuffer()),
);
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
images.forEach((image, i) => {
  const pos = 6 + 16 * i;
  header[pos] = sizes[i] === 256 ? 0 : sizes[i];
  header[pos + 1] = header[pos];
  header.writeUInt16LE(1, pos + 4);
  header.writeUInt16LE(32, pos + 6);
  header.writeUInt32LE(image.length, pos + 8);
  header.writeUInt32LE(offset, pos + 12);
  offset += image.length;
});
await fs.writeFile('build/icon.ico', Buffer.concat([header, ...images]));
