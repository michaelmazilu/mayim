/**
 * Copy MapLibre's web worker into public/ so the browser can load it by URL.
 *
 * MapLibre 6 finds its worker beside its own module URL, and the bundler
 * rewrites that URL — so, left alone, it spawns the worker from the page
 * itself and every GeoJSON layer waits forever for a reply. AquaMap points
 * `setWorkerUrl` at the copy made here instead. The worker imports the shared
 * chunk by relative path, so both files go to the same directory.
 *
 * Runs before `dev` and `build`, so the copy always matches the installed
 * version; the output is gitignored.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "maplibre");

mkdirSync(out, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  copyFileSync(join(dist, file), join(out, file));
}
console.log(`maplibre worker copied to ${out}`);
