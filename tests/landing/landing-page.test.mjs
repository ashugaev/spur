import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const html = await readFile(new URL("../../landing/index.html", import.meta.url), "utf8");
const structured = JSON.parse(
  html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
);
const faq = structured["@graph"].find((entry) => entry["@type"] === "FAQPage");

function section(id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.notEqual(start, -1, `missing #${id}`);
  const end = html.indexOf("</section>", start);
  assert.notEqual(end, -1, `unclosed #${id}`);
  return html.slice(start, end + 10);
}

function faqAnswer(question) {
  const visible = html
    .match(
      new RegExp(
        `<summary>\\s*${question.replace("?", "\\?")}[\\s\\S]*?<div class="ans">([\\s\\S]*?)<\\/div>`,
      ),
    )?.[1]
    ?.replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const json = faq.mainEntity.find((entry) => entry.name === question).acceptedAnswer.text;
  return { visible, json };
}

test("navigation stays on-page and GitHub buttons identify their destination", () => {
  const navigation = html.match(/<nav\b[\s\S]*?<\/nav>/)?.[0];
  assert.ok(navigation, "missing navigation");
  assert.doesNotMatch(navigation, /href="https:\/\/github\.com\//);

  const githubButtons = [...html.matchAll(/<a\b[^>]*class="btn(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/a>/g)]
    .map(([anchor]) => anchor)
    .filter((anchor) => /href="https:\/\/github\.com\//.test(anchor));
  assert.deepEqual(
    githubButtons.map((button) => button.match(/href="([^"]+)"/)[1]).sort(),
    [
      "https://github.com/ashugaev/spur",
      "https://github.com/ashugaev/spur/stargazers",
      "https://github.com/ashugaev/spur/blob/main/docs/mcp.md",
    ].sort(),
  );
  for (const button of githubButtons) {
    assert.match(button, /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/);
  }
  const heroButtons = html.match(/<div class="hero-cta">[\s\S]*?<\/div>/)?.[0];
  assert.ok(heroButtons, "missing hero buttons");
  assert.match(heroButtons, /href="https:\/\/github\.com\/ashugaev\/spur"/);
  assert.match(heroButtons, /Get Spur &rarr;/);
  assert.match(heroButtons, /href="#dashboard">See it running<\/a>/);
  const starButton = githubButtons.find((button) => /\/stargazers"/.test(button));
  assert.ok(starButton, "missing GitHub star button");
  assert.equal(starButton.replace(/<[^>]+>/g, "").trim(), "Star on GitHub");
});

test("hosting copy names physical and virtual computers without box metaphors", () => {
  const architecture = section("architecture");
  assert.match(architecture, /computer, server or VM/);
  assert.match(architecture, /Use the same sessions locally/);
  assert.match(architecture, /connect\s+from another device after setting up Tailscale/);
  const visibleBody = html
    .slice(html.indexOf("<body>"))
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, "");
  assert.doesNotMatch(visibleBody, /\bbox\b|machine you own/i);
  const { visible } = faqAnswer("Which operating systems work?");
  assert.match(visible, /about 1 GB of RAM; 2 GB is recommended/);
});

test("hero routes supported events through one accessible visual", () => {
  const hero = html.slice(html.indexOf('<header class="hero'), html.indexOf("</header>"));
  assert.match(hero, /<figure class="fanout" role="img" aria-labelledby="fanout-desc">/);
  assert.equal((hero.match(/id="fanout-desc"/g) ?? []).length, 1);
  assert.match(hero, /<svg[^>]+aria-hidden="true" focusable="false">/);
  assert.equal((hero.match(/class="fo-pkt"/g) ?? []).length, 1);
  assert.equal((hero.match(/data-source-kind="event"/g) ?? []).length, 3);
  assert.equal((hero.match(/data-source-kind="context"/g) ?? []).length, 1);
  assert.equal((hero.match(/class="fo-agent"/g) ?? []).length, 4);
  const visual = hero.slice(hero.indexOf('<figure class="fanout'), hero.indexOf("</figure>"));
  for (const label of ["GitHub", "Sentry", "cron", "Jira"]) {
    assert.match(hero, new RegExp(`>${label}<`));
  }
  for (const agent of ["claude", "codex", "cursor", "opencode"]) {
    assert.equal((visual.match(new RegExp(`>${agent}<`, "g")) ?? []).length, 1);
  }
  assert.doesNotMatch(hero, /Slack|GitLab|Telegram|fo-secondary-label|fo-agent-state|fo-cap/);
  assert.match(
    hero.replace(/\s+/g, " "),
    /GitHub, Sentry and cron events enter Spur, which routes work to one CLI agent and returns the result to you\. Jira supplies backlog context or queried work items\./,
  );
  assert.match(
    html.slice(html.indexOf("var sources"), html.indexOf("var agents")),
    /querySelectorAll\('\.fo-source\[data-source-kind="event"\]'\)/,
  );
  assert.doesNotMatch(html, /fo-agent-state|fo-secondary-label|fo-context-label|fo-cap/);
});

test("hero routes start at four sources aligned with the four agent rows", () => {
  const visual = html.slice(html.indexOf('<figure class="fanout'), html.indexOf("</figure>"));
  const sources = [
    ...visual.matchAll(
      /<g class="fo-source"([^>]*)>\s*<rect x="6" y="(\d+)" width="118" height="(\d+)"/g,
    ),
  ];
  const agents = [
    ...visual.matchAll(
      /<g class="fo-agent"[^>]*data-y="(\d+)">\s*<rect x="334" y="(\d+)" width="120" height="(\d+)"/g,
    ),
  ];
  assert.equal(sources.length, 4);
  assert.equal(agents.length, 4);
  const sourceRows = sources.map(([, , y, height]) => Number(y) + Number(height) / 2);
  const agentRows = agents.map(([, routeY, y, height]) => {
    const center = Number(y) + Number(height) / 2;
    assert.equal(Number(routeY), center, "agent route must meet the node center");
    return center;
  });
  assert.deepEqual(sourceRows, agentRows);
  for (const [index, [, attributes]] of sources.entries()) {
    const row = sourceRows[index];
    if (attributes.includes('data-source-kind="event"')) {
      assert.match(attributes, new RegExp(`data-y="${row}"`));
    }
    assert.match(visual, new RegExp(`class="fo-wire" d="M124 ${row} [^"]*190 190"`));
    assert.match(visual, new RegExp(`class="fo-wire fo-wire-main" d="M250 190 [^"]*334 ${row}"`));
  }
});

test("hero face keeps eyes and mouth visible without frame-swapping animation", () => {
  const user = html.slice(html.indexOf('<g class="fo-user">'), html.indexOf('<g class="fo-hub">'));
  assert.equal((user.match(/class="fo-face"/g) ?? []).length, 1);
  assert.equal((user.match(/class="fo-eye"/g) ?? []).length, 2);
  assert.equal((user.match(/class="fo-mouth"/g) ?? []).length, 1);
  assert.match(user, /class="fo-you-frame"/);
  assert.doesNotMatch(user, /tabindex|aria-label/);
  assert.doesNotMatch(html, /chomp|\.fo-you g(?:\s|[{:])/);
  for (const gesture of ["face-blink", "face-mouth"]) {
    assert.match(html, new RegExp(`animation: ${gesture} `));
    assert.match(html, new RegExp(`@keyframes ${gesture}`));
  }
  const reduced = html.slice(
    html.indexOf("@media (prefers-reduced-motion: reduce)"),
    html.indexOf("</style>", html.indexOf("@media (prefers-reduced-motion: reduce)")),
  );
  assert.match(reduced, /\*\s*{[^}]*animation: none !important/);
  assert.doesNotMatch(reduced, /\.fo-(?:you|face|eye|mouth)/);
});

test("architecture owns one compact diagram with a clipped connection track", () => {
  const architecture = section("architecture");
  const heading = architecture.slice(0, architecture.indexOf('<figure class="arch'));
  assert.match(heading, /<h2 id="architecture-h">Run agents on your computer or server\.<\/h2>/);
  assert.equal((heading.match(/<p>/g) ?? []).length, 1);
  assert.match(heading, /install-from-npm\.md#private-access-tailscale-default-on/);
  assert.match(architecture, /<figure class="arch rv" role="img" aria-labelledby="arch-desc">/);
  assert.equal((architecture.match(/id="arch-desc"/g) ?? []).length, 1);
  assert.equal((architecture.match(/class="a-diagram" aria-hidden="true"/g) ?? []).length, 1);
  assert.equal((architecture.match(/class="a-card"/g) ?? []).length, 2);
  assert.equal((architecture.match(/class="a-connection"/g) ?? []).length, 1);
  assert.equal((architecture.match(/class="a-track"/g) ?? []).length, 1);
  assert.equal((architecture.match(/class="a-pkt"/g) ?? []).length, 1);
  for (const label of ["Your device", "Spur + agents", "Tailscale"]) {
    assert.equal(architecture.split(`>${label}<`).length - 1, 1);
  }
  const track = architecture.match(/<div class="a-track">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(track, "missing packet track");
  assert.match(track, /class="a-pkt"/);
  assert.doesNotMatch(track, /a-link-label|Tailscale/);
  assert.match(html, /\.a-track\s*{[^}]*height: 6px;[^}]*overflow: hidden/);
  assert.doesNotMatch(html, /arch-route--desktop|arch-route--mobile|offset-path/);
  assert.match(
    architecture.replace(/\s+/g, " "),
    /Use a local browser on that computer, or connect from another device after setting up Tailscale\. Requests and responses use the same connection\./,
  );
});

test("pipeline exposes one ordered incident flow and every agent-work state", () => {
  const pipeline = section("pipeline");
  assert.equal((pipeline.match(/class="incident-flow"/g) ?? []).length, 1);
  assert.equal((pipeline.match(/class="incident-step"/g) ?? []).length, 5);
  const stages = [
    "CI fails on main",
    "Spur starts one agent",
    "Agent investigates and fixes",
    "Checks pass",
    "Merged after review",
  ];
  let cursor = 0;
  for (const stage of stages) {
    const next = pipeline.indexOf(stage, cursor);
    assert.notEqual(next, -1, `missing or out-of-order stage: ${stage}`);
    cursor = next;
  }
  for (const state of ["reading failed job", "editing", "fix ready"]) {
    assert.match(pipeline, new RegExp(`>${state}<`));
  }
  assert.doesNotMatch(html, /class="(?:tl|pipe|wf)(?:\s|"|-)/);
  assert.doesNotMatch(html, /@keyframes (?:handoff|wftok|wfdot|wfcard|wfstep)/);
});

test("truth copy and FAQ structured data stay aligned", () => {
  assert.match(html, /<h2 id="features-h">One control plane for every agent\.<\/h2>/);
  assert.match(
    html,
    /Close the shell or drop SSH and tmux keeps running\. Daemon restarts rediscover live\s+sessions; restore after a host reboot is opt-in per project\./,
  );
  assert.match(html, /<h3>Spur has no cloud relay\.<\/h3>/);
  assert.match(
    html,
    /Spur stores its state on the computer or server where you install it\. Agent CLIs and\s+configured integrations still send data to their own providers\./,
  );
  const answer =
    "Spur stores its state on the computer or server where you install it. There is no Spur cloud. Agent CLIs and configured integrations still send data to their own providers. The web UI listens on localhost. Once Tailscale is connected, the default setup also makes it available at your private Tailscale address. Public exposure requires the explicit --expose-web flag.";
  const { visible, json } = faqAnswer("Where does my data go?");
  assert.equal(visible, answer);
  assert.equal(json, answer);
  assert.equal((html.match(/class="pm" aria-hidden="true"/g) ?? []).length, 7);
});

test("event-source FAQ distinguishes spawn sources and live-session messages", () => {
  const { visible, json } = faqAnswer("What can trigger an agent automatically?");

  assert.equal(visible, json);
  for (const source of [
    "GitHub",
    "GitLab",
    "Telegram",
    "service",
    "Cron",
    "GitHub CI",
    "Sentry",
    "queried Jira",
    "scripts",
    "webhooks",
  ]) {
    assert.ok(visible.includes(source), `missing source: ${source}`);
  }
  assert.match(visible, /Cron,[^.]+spawn new sessions\./);
  assert.match(visible, /Jira[^.]+backlog context without a query/);
  assert.doesNotMatch(html, /(?:Six|Seven) pollers|systemd service logs/i);
});

test("every visible FAQ answer matches its structured answer", () => {
  for (const entry of faq.mainEntity) {
    const { visible, json } = faqAnswer(entry.name);
    assert.equal(visible, json, entry.name);
  }
});

test("feature cards describe supported controls and their limits", () => {
  const features = section("features");
  assert.equal((features.match(/<article class="cell">/g) ?? []).length, 12);
  for (const heading of ["MCP control", "Token budgets", "Reasoning effort"]) {
    assert.ok(features.includes(`<h3>${heading}</h3>`), `missing feature: ${heading}`);
  }
  assert.match(features, /trusted MCP clients/);
  assert.match(features, /href="#mcp">Explore MCP &rarr;<\/a>/);
  assert.match(features, /Unknown usage stays\s+unenforced/);
  assert.match(features, /warn only/);
  assert.match(features, /choices follow\s+the\s+selected agent and model/);
  for (const command of ["/new", "/work", "/watch"]) {
    assert.ok(features.includes(`<code>${command}</code>`), `missing Telegram action: ${command}`);
  }
  assert.match(features, /Detached\s+containers need their own teardown/);
  assert.doesNotMatch(features, /die with the\s+session/);
});

test("MCP section links qualified client control to the canonical setup guide", () => {
  const mcp = section("mcp");
  assert.ok(html.indexOf('<section id="cli"') < html.indexOf('<section id="mcp"'));
  assert.ok(html.indexOf('<section id="mcp"') < html.indexOf('<section id="install"'));
  const navigation = html.match(/<nav\b[\s\S]*?<\/nav>/)?.[0];
  assert.match(navigation, /href="#mcp">MCP<\/a>/);
  assert.match(mcp, /<h2 id="mcp-h">Your AI has tools\. Now give it a team\.<\/h2>/);
  assert.match(mcp, /Connect an MCP-compatible client to Spur/);
  for (const capability of ["Start agents", "Send work", "Check progress"]) {
    assert.match(mcp, new RegExp(`<strong>${capability}<\/strong>`));
  }
  assert.match(mcp, /Read conversations and wait for an answer or question/);
  assert.match(mcp, /Use stdio locally or over SSH, or connect through private HTTP\./);
  assert.match(mcp, /Connected clients get full operator access to Spur\./);
  assert.equal((mcp.match(/href="https:\/\//g) ?? []).length, 1);
  assert.match(mcp, /href="https:\/\/github\.com\/ashugaev\/spur\/blob\/main\/docs\/mcp\.md"/);
  assert.match(mcp, /Connect your MCP client &rarr;/);
});

test("MCP diagram describes one request and session without relying on animation", () => {
  const mcp = section("mcp");
  assert.match(mcp, /<figure class="mcp-flow rv" role="img" aria-labelledby="mcp-desc">/);
  assert.equal((mcp.match(/id="mcp-desc"/g) ?? []).length, 1);
  assert.match(mcp, /class="mcp-stages" aria-hidden="true"/);
  assert.equal((mcp.match(/class="mcp-stage(?: mcp-stage--hub)?"/g) ?? []).length, 3);
  for (const label of ["Your MCP client", "Spur", "One agent session"]) {
    assert.equal((mcp.match(new RegExp(`<strong>${label}<\/strong>`, "g")) ?? []).length, 1);
  }
  for (const agent of ["claude", "codex", "cursor", "opencode"]) {
    assert.equal((mcp.match(new RegExp(`\\b${agent}\\b`, "g")) ?? []).length, 1);
  }
  assert.equal((mcp.match(/class="mcp-link"[^>]*focusable="false"/g) ?? []).length, 2);
  assert.equal((mcp.match(/class="mcp-track"/g) ?? []).length, 2);
  assert.equal((mcp.match(/class="mcp-pkt /g) ?? []).length, 4);
  assert.match(
    mcp.replace(/\s+/g, " "),
    /Spur starts or messages one coding-agent session; the client can then read its progress, answer or question\./,
  );
});

test("installation requirements match supported Node engines and installed services", async () => {
  const install = section("install");
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.engines.node, "^22.13.0 || >=24");
  assert.match(install, /Node 22\.13\+ \(22\.x\), or Node 24 and later/);
  assert.doesNotMatch(install, /Node 20|both as systemd/);
  assert.match(install, /daemon, web and MCP systemd user services/);
});

test("canvas settles while hidden and wakes when visible or touched", () => {
  const canvasScript = html.slice(
    html.indexOf("var energy = 0"),
    html.indexOf("})();\n    </script>"),
  );
  const touchHandler = canvasScript.slice(
    canvasScript.indexOf('"touchstart"'),
    canvasScript.indexOf('"scroll"'),
  );
  const visibilityHandler = canvasScript.slice(
    canvasScript.indexOf('document.addEventListener("visibilitychange"'),
  );

  assert.match(canvasScript, /function wake\(\)/);
  assert.match(canvasScript, /if \(!live && !document\.hidden\)/);
  assert.match(canvasScript, /raf = requestAnimationFrame\(frame\)/);
  assert.match(touchHandler, /energy = Math\.min\(1, energy \+ 0\.25\)/);
  assert.match(touchHandler, /wake\(\)/);
  for (const required of ["cancelAnimationFrame(raf)", "live = false", "energy = 0", "paint()"]) {
    assert.match(visibilityHandler, new RegExp(required.replace(/[()]/g, "\\$&")));
  }
  assert.match(visibilityHandler, /else \{[\s\S]*wake\(\)/);
});

test("motion-safe CSS keeps all static meaning visible", () => {
  const reduced = html.slice(html.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /animation: none !important/);
  assert.match(reduced, /transition: none !important/);
  assert.match(reduced, /\.a-pkt,[\s\S]*\.fo-pkt,[\s\S]*\.mcp-pkt[\s\S]*display: none/);
  assert.match(reduced, /\.agent-state[\s\S]*opacity: 1/);
  for (const id of ["features", "cli", "install", "faq"]) section(id);
});

test("no-script cascade overrides the later reveal rule", () => {
  const noScript = html.match(
    /<noscript>[\s\S]*?<style>([\s\S]*?)<\/style>[\s\S]*?<\/noscript>/,
  )?.[1];
  assert.ok(noScript, "missing no-script styles");
  assert.match(noScript, /html \.rv\s*{[^}]*opacity: 1 !important/);
  assert.match(noScript, /html \.rv\s*{[^}]*transform: none !important/);
  assert.match(noScript, /html \.rv\s*{[^}]*transition: none !important/);
});
