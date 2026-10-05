#!/usr/bin/env node

import { writeIsolatedProjectConfig } from "../dist/isolated-project-config.js";
import { isolatedTelegramLockPath, loadIsolatedTelegram } from "../dist/isolated-telegram.js";
import { readFileSync, writeFileSync } from "node:fs";

const args = globalThis.process.argv.slice(2);

function take(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

const inputPath = take("--input");
const outputPath = take("--output");
const currentWorktreePath = take("--worktree");
const currentBranch = take("--branch");
const project = take("--project");
const lockOutput = take("--telegram-lock-output");

if (!inputPath || !outputPath || !currentWorktreePath) {
  throw new Error(
    "Usage: write-isolated-project-config --input <path> --output <path> --worktree <path> [--branch <name>]",
  );
}

try {
  const seed = args.includes("--telegram-env-stdin") ? readFileSync(0, "utf8") : undefined;
  if (seed !== undefined && !project) throw new Error("Telegram TEST seed requires --project");
  let telegram;
  if (project && !args.includes("--without-telegram")) {
    try {
      telegram = loadIsolatedTelegram(currentWorktreePath, seed);
    } catch (error) {
      if (
        seed === undefined ||
        !(error instanceof Error) ||
        !error.message.startsWith("Missing TELEGRAM_TEST_")
      )
        throw error;
      globalThis.process.stderr.write(`${error.message}\n`);
    }
  }
  writeIsolatedProjectConfig({
    inputPath,
    outputPath,
    currentWorktreePath,
    currentBranch,
    ...(project ? { options: { project, telegram } } : {}),
  });
  if (lockOutput)
    writeFileSync(lockOutput, telegram ? isolatedTelegramLockPath(telegram) : "", { mode: 0o600 });
  if (project)
    globalThis.process.stdout.write(
      `${telegram ? "Telegram TEST configured" : args.includes("--without-telegram") ? "Telegram TEST disabled" : "Telegram NOT_CONNECTED/missing-fixture"}\n`,
    );
} catch (error) {
  const message =
    error instanceof Error &&
    /^(Missing TELEGRAM_TEST_|Invalid TELEGRAM_TEST_|Malformed Telegram TEST|Unexpected Telegram TEST|Telegram TEST|Unsafe Telegram TEST|Cannot .*Telegram TEST|Unknown isolated project)/.test(
      error.message,
    )
      ? error.message
      : "Cannot configure isolated Telegram TEST";
  globalThis.process.stderr.write(`${message}\n`);
  globalThis.process.exitCode = 1;
}
