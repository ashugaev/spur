#!/usr/bin/env node
// Rewrite the landing page's origin everywhere it appears, so the domain is
// one command rather than a hand sweep across index.html, og.html, robots.txt
// and sitemap.xml. Also restamps the sitemap's lastmod.
//
//   node scripts/landing-set-origin.mjs https://spur.example
import { readFile, writeFile } from "node:fs/promises";
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

const ORIGIN_RE =
  /https?:\/\/(?!raw\.githubusercontent\.com|github\.com|fonts\.|www\.|schema\.org|www\.apache\.org|www\.sitemaps\.org)[a-z0-9.-]+(?::\d+)?/gi;
const files = ["index.html", "og.html", "robots.txt", "sitemap.xml"];
const today = new Date().toISOString().slice(0, 10);

let touched = 0;
for (const name of files) {
  const path = join(landing, name);
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    continue;
  }
  let out = text.replace(ORIGIN_RE, origin);
  if (name === "sitemap.xml") {
    out = out.replace(/<lastmod>[^<]*<\/lastmod>/g, `<lastmod>${today}</lastmod>`);
  }
  if (out !== text) {
    await writeFile(path, out);
    touched++;
    console.log(`updated ${name}`);
  }
}

console.log(touched ? `origin set to ${origin}` : `already ${origin}`);
