#!/usr/bin/env node

import { writeIsolatedProjectConfig } from "../dist/isolated-project-config.js";

const args = process.argv.slice(2);

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

if (!inputPath || !outputPath || !currentWorktreePath) {
  throw new Error("Usage: write-isolated-project-config --input <path> --output <path> --worktree <path> [--branch <name>]");
}

writeIsolatedProjectConfig({
  inputPath,
  outputPath,
  currentWorktreePath,
  currentBranch,
});
