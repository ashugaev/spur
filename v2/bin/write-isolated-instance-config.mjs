#!/usr/bin/env node

import { writeIsolatedInstanceConfig } from "../dist/isolated-instance-config.js";

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

const userConfigPath = take("--user-config");
const basePath = take("--base");
const outputPath = take("--output");

if (!userConfigPath || !basePath || !outputPath) {
  throw new Error(
    "Usage: write-isolated-instance-config --user-config <path> --base <path> --output <path>",
  );
}

writeIsolatedInstanceConfig({
  userConfigPath,
  basePath,
  outputPath,
});
