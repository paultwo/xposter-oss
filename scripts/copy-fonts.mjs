import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "fonts");
const files = [
  [
    "@fontsource/public-sans/files/public-sans-latin-400-normal.woff2",
    "public-sans-latin-400-normal.woff2",
  ],
  [
    "@fontsource/public-sans/files/public-sans-latin-600-normal.woff2",
    "public-sans-latin-600-normal.woff2",
  ],
  [
    "@fontsource/newsreader/files/newsreader-latin-400-normal.woff2",
    "newsreader-latin-400-normal.woff2",
  ],
  [
    "@fontsource/newsreader/files/newsreader-latin-600-normal.woff2",
    "newsreader-latin-600-normal.woff2",
  ],
  ["@fontsource/public-sans/LICENSE", "OFL-public-sans.txt"],
  ["@fontsource/newsreader/LICENSE", "OFL-newsreader.txt"],
];

await mkdir(out, { recursive: true });
for (const [from, name] of files) {
  await copyFile(join(root, "node_modules", from), join(out, name));
}
