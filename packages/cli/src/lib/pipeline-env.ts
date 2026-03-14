import chalk from "chalk";

export function getEnv(): { sessionId: string; dashboardUrl: string } {
  const sessionId = process.env["AO_SESSION"];
  if (!sessionId) {
    console.error(chalk.red("AO_SESSION environment variable is required"));
    process.exit(1);
  }
  const dashboardUrl =
    process.env["AO_API_URL"] || process.env["AO_DASHBOARD_URL"] || "http://localhost:3000";
  return { sessionId, dashboardUrl };
}
