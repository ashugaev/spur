import { readFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

// Keep the owned process alive long enough for the parent's /proc observation.
await setTimeout(40);
if (process.argv[2] === "--version") {
  process.stdout.write("fixture-current\n");
} else {
  const config = JSON.parse(await readFile(process.argv[5], "utf8"));
  process.stdout.write(
    JSON.stringify([
      { lane: "code", status: config.status },
      { lane: "browser", status: config.status },
    ]) + "\n",
  );
}
