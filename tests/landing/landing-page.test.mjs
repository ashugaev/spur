import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

const html = await readFile(new URL("../../landing/index.html", import.meta.url), "utf8");

function section(id) {
  const start = html.indexOf(`<section id="${id}"`);
  assert.notEqual(start, -1, `missing #${id}`);
  const end = html.indexOf("</section>", start);
  assert.notEqual(end, -1, `unclosed #${id}`);
  return html.slice(start, end + 10);
}

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
    /GitHub, GitLab, Sentry, cron, and Telegram events enter Spur, which routes work to one CLI agent and returns the result to you\. Jira supplies backlog context\./,
  );
  assert.doesNotMatch(
    html.slice(html.indexOf("var sources"), html.indexOf("var agents")),
    /context|Jira/,
  );
});

test("architecture owns one description and two hidden responsive drawings", () => {
  const architecture = section("architecture");
  const heading = architecture.slice(0, architecture.indexOf('<figure class="arch'));
  assert.match(
    heading,
    /The web UI binds to loopback; the default Tailscale setup adds your tailnet IP\. Public\s+exposure requires the explicit <code>--expose-web<\/code> flag\./,
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
    /Spur stores its state on your machine\. Agent CLIs and configured integrations still\s+send data to their own providers\./,
  );
  const answer =
    "Spur stores its state on your machine and has no Spur cloud. Agent CLIs and configured integrations still send data to their own providers. The web UI binds to loopback; the default Tailscale setup adds your tailnet IP, and public exposure is an explicit override.";
  const visible = html
    .match(
      /<summary>\s*Does my code leave the box\?[\s\S]*?<div class="ans">([\s\S]*?)<\/div>/,
    )?.[1]
    ?.replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const structured = JSON.parse(
    html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
  );
  const faq = structured["@graph"].find((entry) => entry["@type"] === "FAQPage");
  const jsonAnswer = faq.mainEntity.find((entry) => entry.name === "Does my code leave the box?")
    .acceptedAnswer.text;
  assert.equal(visible, answer);
  assert.equal(jsonAnswer, answer);
  assert.equal(visible, jsonAnswer);
  assert.equal((html.match(/class="pm" aria-hidden="true"/g) ?? []).length, 7);
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
