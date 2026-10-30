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
  assert.equal(githubButtons.length, 2);
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
  assert.match(architecture, /computer, a dedicated server or a virtual machine/);
  assert.match(architecture, /connect to the same sessions from your other devices/);
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
  assert.equal((hero.match(/data-source-kind="event"/g) ?? []).length, 5);
  assert.equal((hero.match(/data-source-kind="context"/g) ?? []).length, 1);
  assert.equal((hero.match(/class="fo-agent"/g) ?? []).length, 4);
  const visual = hero.slice(hero.indexOf('<figure class="fanout'), hero.indexOf("</figure>"));
  for (const label of ["GitHub", "GitLab", "Sentry", "Telegram", "cron", "Jira", "backlog"]) {
    assert.match(hero, new RegExp(`>${label}<`));
  }
  for (const agent of ["claude", "codex", "cursor", "opencode"]) {
    assert.equal((visual.match(new RegExp(`>${agent}<`, "g")) ?? []).length, 1);
  }
  assert.doesNotMatch(hero, /Slack/i);
  assert.match(
    hero.replace(/\s+/g, " "),
    /GitHub, GitLab, Sentry, cron, and Telegram events enter Spur, which routes work to one CLI agent and returns the result to you\. Jira supplies backlog context or queried work items\./,
  );
  assert.doesNotMatch(
    html.slice(html.indexOf("var sources"), html.indexOf("var agents")),
    /context|Jira/,
  );
});

test("hero face keeps eyes and mouth visible without frame-swapping animation", () => {
  const user = html.slice(html.indexOf('<g class="fo-user">'), html.indexOf('<g class="fo-hub">'));
  assert.equal((user.match(/class="fo-face"/g) ?? []).length, 1);
  assert.equal((user.match(/class="fo-eye"/g) ?? []).length, 2);
  assert.equal((user.match(/class="fo-mouth"/g) ?? []).length, 1);
  assert.match(user, /class="fo-you-frame"/);
  assert.match(user, />you<\/text>/);
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

test("architecture owns one description and two hidden responsive drawings", () => {
  const architecture = section("architecture");
  const heading = architecture.slice(0, architecture.indexOf('<figure class="arch'));
  assert.match(
    heading,
    /The web UI listens on localhost\. Once Tailscale is connected,[\s\S]*?your private Tailscale address\. Public exposure requires the\s+explicit <code>--expose-web<\/code> flag\./,
  );
  assert.match(architecture, /<figure class="arch rv" role="img" aria-labelledby="arch-desc">/);
  assert.equal((architecture.match(/id="arch-desc"/g) ?? []).length, 1);
  assert.equal((architecture.match(/aria-hidden="true"\s+focusable="false"/g) ?? []).length, 2);
  assert.equal((architecture.match(/class="arch-route--desktop"/g) ?? []).length, 1);
  assert.equal((architecture.match(/class="arch-route--mobile"/g) ?? []).length, 1);
  assert.equal((architecture.match(/class="a-pkt"/g) ?? []).length, 2);
  assert.equal((architecture.match(/class="a-stage"/g) ?? []).length, 6);
  for (const label of ["YOUR DEVICES", "TAILSCALE", "YOUR MACHINE"]) {
    assert.equal((architecture.match(new RegExp(`>${label}<`, "g")) ?? []).length, 2);
  }
  assert.match(
    architecture.replace(/\s+/g, " "),
    /Your devices reach the Spur daemon and its agent sessions through Tailscale; responses return over the same private route\. The web UI remains on loopback, and public exposure is an explicit override\./,
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
  assert.match(features, /Full operator access/);
  assert.match(features, /Unknown usage stays\s+unenforced/);
  assert.match(features, /warn only/);
  assert.match(features, /choices follow\s+the\s+selected agent and model/);
  for (const command of ["/new", "/work", "/watch"]) {
    assert.ok(features.includes(`<code>${command}</code>`), `missing Telegram action: ${command}`);
  }
  assert.match(features, /Detached\s+containers need their own teardown/);
  assert.doesNotMatch(features, /die with the\s+session/);
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
  assert.match(reduced, /\.a-pkt,[\s\S]*\.fo-pkt[\s\S]*display: none/);
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
