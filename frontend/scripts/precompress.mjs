// Writes Brotli (quality 11) and gzip (level 9) siblings for the text files of the production build,
// so that Caddy serves them with `file_server { precompressed br gzip }` instead of compressing on the
// fly at a lower level. A sibling is kept only when it saves at least 10 percent. Source maps and
// already compressed formats (fonts, images) are skipped.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = path.resolve(process.argv[2] ?? 'dist');
const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.txt', '.xml', '.webmanifest']);
const MIN_BYTES = 1024;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let raw = 0;
let br = 0;
let count = 0;
for await (const file of walk(ROOT)) {
  if (!TEXT.has(path.extname(file))) continue;
  if ((await stat(file)).size < MIN_BYTES) continue;
  const data = await readFile(file);
  const variants = [
    [
      '.br',
      brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
      }),
    ],
    ['.gz', gzipSync(data, { level: 9 })],
  ];
  for (const [ext, out] of variants) {
    if (out.length <= data.length * 0.9) await writeFile(file + ext, out);
  }
  raw += data.length;
  br += variants[0][1].length;
  count += 1;
}
console.log(
  `precompress: ${count} files, ${(raw / 1024).toFixed(0)} KiB raw, ${(br / 1024).toFixed(0)} KiB brotli`,
);
