#!/usr/bin/env node
// Static server for landing/ with live reload. Dev only — the reload snippet is
// injected into HTML responses at serve time, never written to the file.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";

const root = resolve(process.argv[2] ?? "landing");
const port = Number(process.env.SPUR_RESERVED_PORT_LANDING ?? process.argv[3] ?? 5700);
const host = process.env.LANDING_HOST ?? "0.0.0.0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const RELOAD_SNIPPET = `<script>
(function () {
  var es = new EventSource("/__reload");
  es.onmessage = function () { location.reload(); };
  es.onerror = function () { es.close(); setTimeout(function () { location.reload(); }, 1000); };
})();
</script>`;

/** @type {Set<import("node:http").ServerResponse>} */
const clients = new Set();

let debounce = null;
watch(root, { recursive: true }, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    for (const client of clients) client.write("data: reload\n\n");
  }, 80);
});

function resolveWithinRoot(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const target = resolve(join(root, decoded === "/" ? "index.html" : decoded));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  if (req.url === "/__reload") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 500\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const target = resolveWithinRoot(req.url ?? "/");
  if (!target) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let file = target;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    res.writeHead(404).end("Not found");
    return;
  }

  try {
    const body = await readFile(file);
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    if (type.startsWith("text/html")) {
      const html = body.toString("utf8").replace("</body>", `${RELOAD_SNIPPET}\n</body>`);
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(html);
      return;
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`Serving ${root} with live reload on http://${host}:${port}`);
});
