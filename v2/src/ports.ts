// Default ports, kept in a dependency-free leaf module so both the config
// loader and the systemd/unit health code read the same number without an
// import cycle (`update-health.ts` already imports `config.ts` for
// `loadConfig`) and without every `vi.mock("../../src/config.js")` factory
// having to re-export them.
//
// `ui.port` is the web UI's listen port: `spur-web.service` carries it as
// `Environment=PORT`, and `web-server.ts` falls back to the config value when
// that env is absent. Same number in both places or `spur doctor` reports
// `web-ui-port-drift`.
export const DEFAULT_UI_PORT = 5555;
