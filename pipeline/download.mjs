// Downloads the active Natural Earth source layers (per pipeline/sources.mjs)
// into data/raw/. Idempotent: skips files that already exist unless --force.
import { mkdir, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { activeLayers, rawUrl } from "./sources.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = join(ROOT, "data", "raw");
const FORCE = process.argv.includes("--force");

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function download(file) {
  const dest = join(RAW_DIR, file);
  if (!FORCE && (await exists(dest))) {
    console.log(`  skip  ${file} (exists)`);
    return;
  }
  const url = rawUrl(file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const { size } = await stat(dest);
  console.log(`  ok    ${file} (${(size / 1024).toFixed(0)} KB)`);
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });
  const files = activeLayers().flatMap((l) => l.scales.map((s) => l.file(s)));
  console.log(`Downloading ${files.length} source file(s) to data/raw/`);
  for (const f of files) await download(f);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
