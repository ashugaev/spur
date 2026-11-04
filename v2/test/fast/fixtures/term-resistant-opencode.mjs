#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import process from "node:process";
import { setInterval } from "node:timers";

process.on("SIGTERM", () => {});
writeFileSync(process.env.SPUR_TEST_OPENCODE_PID, String(process.pid));
setInterval(() => {}, 1000);
