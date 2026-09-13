import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "dist");
const publicFiles = [
  "_headers",
  "index.html",
  "styles.css",
  "ledger.css",
  "runtime-storage.js",
  "overview-map.js",
  "route-ui.js",
  "app.js",
  "ticket-pdf-preview.js",
  "ledger.js",
  "site-navigation.js",
  "trip-data.json"
];
const publicDirectories = [
  "assets"
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const file of publicFiles) {
  await cp(path.join(root, file), path.join(outDir, file));
}

for (const directory of publicDirectories) {
  await cp(path.join(root, directory), path.join(outDir, directory), { recursive: true });
}

console.log(`Cloudflare Pages build complete: ${path.relative(root, outDir)}`);
