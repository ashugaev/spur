#!/usr/bin/env node
// Rewrite the landing page's origin everywhere it appears, so the domain is
// one command rather than a hand sweep across index.html, og.html, robots.txt
// and sitemap.xml. Also restamps the sitemap's lastmod.
//
//   node scripts/landing-set-origin.mjs https://spur.example
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const landing = resolve(join(here, "..", "landing"));

const next = process.argv[2];
if (!next) {
  console.error("usage: landing-set-origin.mjs <origin>   e.g. https://spur.example");
  process.exit(1);
}

let origin;
try {
  const parsed = new URL(next);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
  origin = parsed.origin;
} catch {
  console.error(`landing-set-origin: not an absolute http(s) origin: ${next}`);
  process.exit(1);
}

// The origin in use is whatever canonical points at. Replacing that one
// literal keeps every other absolute URL on the page untouched; a pattern for
// "some host" would rewrite the next external link someone adds.
const indexPath = join(landing, "index.html");
const index = await readFile(indexPath, "utf8");
const canonical = index.match(/<link\s+rel="canonical"\s+href="(https?:\/\/[^/"]+)/i);
if (!canonical) {
  console.error("landing-set-origin: no <link rel=canonical> in landing/index.html");
  process.exit(1);
}
const current = canonical[1];

const today = new Date().toISOString().slice(0, 10);
const escaped = current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const currentRe = new RegExp(escaped, "g");

let touched = 0;
for (const name of await readdir(landing)) {
  if (!/\.(html|txt|xml)$/i.test(name)) continue;
  const path = join(landing, name);
  const text = await readFile(path, "utf8");
  let out = text.replace(currentRe, origin);
  if (name === "sitemap.xml") {
    out = out.replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
  }
  if (out !== text) {
    await writeFile(path, out);
    touched++;
    console.log(`updated ${name}`);
  }
}

console.log(touched ? `origin ${current} -> ${origin}` : `already ${origin}`);
