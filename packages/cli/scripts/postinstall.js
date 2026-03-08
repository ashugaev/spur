#!/usr/bin/env node
/* global console */
/* eslint no-console: "off" */

// Subtle star nudge after npm install -- standard practice (Astro, Vite, Bun all do this)
const msg = `
  \x1b[36mAgent Orchestrator\x1b[0m installed successfully.

  Get started:  \x1b[1mao start <github-repo-url>\x1b[0m
  Documentation: https://github.com/ComposioHQ/agent-orchestrator

  \x1b[2mIf this saves you time, consider starring:\x1b[0m
  \x1b[2mhttps://github.com/ComposioHQ/agent-orchestrator\x1b[0m
`;

console.log(msg);
