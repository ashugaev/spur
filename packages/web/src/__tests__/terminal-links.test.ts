import { describe, expect, it } from "vitest";
import {
  areTerminalLinksEqual,
  extractTerminalLinks,
  groupTerminalRows,
  type TerminalBufferRow,
} from "@/lib/terminal-links";

const row = (text: string, isWrapped = false): TerminalBufferRow => ({ text, isWrapped });

const COLS = 80;
const padded = (text: string, isWrapped = false): TerminalBufferRow =>
  row(text.padEnd(COLS, " "), isWrapped);

describe("groupTerminalRows", () => {
  it("joins wrapped rows at full width and trims only the completed logical line", () => {
    expect(
      groupTerminalRows(
        [row("prefix  "), row("  https://example.com/path   ", true), row("next   ")],
        COLS,
      ),
    ).toEqual(["prefix    https://example.com/path", "next"]);
  });

  it("drops wrapped orphans at the leading cutoff", () => {
    expect(
      groupTerminalRows(
        [
          row("https://cut.example", true),
          row("/continued", true),
          row("https://complete.example"),
        ],
        COLS,
      ),
    ).toEqual(["https://complete.example"]);
  });

  it("keeps undefined rows as separators and drops every following wrapped orphan", () => {
    expect(
      groupTerminalRows(
        [
          row("https://before.example"),
          undefined,
          row("https://orphan.example", true),
          row("/still-orphan", true),
          row("https://after.example"),
        ],
        COLS,
      ),
    ).toEqual(["https://before.example", "https://after.example"]);
  });

  it("keeps a full-width row with no URL tail as its own logical line", () => {
    expect(groupTerminalRows([row("x".repeat(COLS)), row("next line")], COLS)).toEqual([
      "x".repeat(COLS),
      "next line",
    ]);
  });
});

describe("extractTerminalLinks", () => {
  it("accepts ASCII-case-insensitive HTTP schemes and rejects other visible text", () => {
    const links = extractTerminalLinks(
      [
        row(
          "ftp://ftp.example file://local mailto:a@example.com javascript:alert(1) example.com " +
            "HTTP://UPPER.example/path https://lower.example",
        ),
      ],
      COLS,
    );

    expect(links.map((link) => link.url)).toEqual([
      "https://lower.example",
      "HTTP://UPPER.example/path",
    ]);
  });

  it("uses rendered OSC labels, not invisible destinations", () => {
    expect(extractTerminalLinks([row("docs https://visible.example")], COLS)).toEqual([
      { url: "https://visible.example", hostname: "visible.example" },
    ]);
    expect(extractTerminalLinks([row("docs")], COLS)).toEqual([]);
  });

  it("trims sentence punctuation, quotes, and unbalanced closing delimiters", () => {
    const links = extractTerminalLinks(
      [
        row(
          'https://one.example/a.,:;!? https://two.example/b"> https://three.example/c))) ' +
            "https://four.example/(balanced) https://five.example/[balanced] " +
            "https://six.example/{balanced}",
        ),
      ],
      COLS,
    );

    expect(links.map((link) => link.url)).toEqual([
      "https://six.example/{balanced}",
      "https://five.example/[balanced]",
      "https://four.example/(balanced)",
      "https://three.example/c",
      "https://two.example/b",
      "https://one.example/a",
    ]);
  });

  it("preserves URL suffixes that are not trimming punctuation", () => {
    expect(
      extractTerminalLinks(
        [row("https://example.com/path/ https://example.com/#frag https://example.com/?q=value")],
        COLS,
      ).map((link) => link.url),
    ).toEqual([
      "https://example.com/?q=value",
      "https://example.com/#frag",
      "https://example.com/path/",
    ]);
  });

  it("rejects invalid and hostless HTTP candidates", () => {
    expect(extractTerminalLinks([row("http:// http://[invalid")], COLS)).toEqual([]);
  });

  it("deduplicates exact literals at their newest occurrence and orders newest first", () => {
    const links = extractTerminalLinks(
      [
        row("https://old.example https://duplicate.example"),
        row(
          "https://Case.example https://case.example https://duplicate.example https://right.example",
        ),
      ],
      COLS,
    );

    expect(links.map((link) => link.url)).toEqual([
      "https://right.example",
      "https://duplicate.example",
      "https://case.example",
      "https://Case.example",
      "https://old.example",
    ]);
  });

  it("derives the hostname without changing the exact URL", () => {
    expect(extractTerminalLinks([row("https://Example.COM:8443/a?q=1#two")], COLS)).toEqual([
      { url: "https://Example.COM:8443/a?q=1#two", hostname: "example.com" },
    ]);
  });

  it("rejoins a URL that tmux hard-wraps across absolute-CUP-redrawn rows with no isWrapped flag", () => {
    const rows: TerminalBufferRow[] = [
      row("https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88"),
      row("ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co"),
      row("m%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainf"),
      row("erence+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_"),
      row("challenge=lvG-MxxE_L5exPAExSNLsDWiLYghHTwpjTeEh0_jQ6c&code_challenge_method=S256"),
      padded("&state=gtD_mHuGv50rZrjpLiaDs4HY7ABLpIx-I1jzPqSam5A"),
    ];

    const links = extractTerminalLinks(rows, COLS);

    expect(links).toHaveLength(1);
    expect(links[0]?.url).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88" +
        "ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.co" +
        "m%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainf" +
        "erence+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_" +
        "challenge=lvG-MxxE_L5exPAExSNLsDWiLYghHTwpjTeEh0_jQ6c&code_challenge_method=S256" +
        "&state=gtD_mHuGv50rZrjpLiaDs4HY7ABLpIx-I1jzPqSam5A",
    );
    expect(links[0]?.hostname).toBe("claude.com");
  });

  it("stops the hard-wrap join at a URL that fills the last column exactly", () => {
    const url = `https://example.com/${"a".repeat(COLS - "https://example.com/".length)}`;
    expect(url).toHaveLength(COLS);

    const links = extractTerminalLinks([row(url), row("╌".repeat(COLS))], COLS);

    expect(links).toEqual([{ url, hostname: "example.com" }]);
  });

  it("does not join a hard-wrap tail into a row that begins with its own scheme", () => {
    const first = `https://one.example/${"a".repeat(COLS - "https://one.example/".length)}`;
    expect(first).toHaveLength(COLS);

    const links = extractTerminalLinks(
      [first, "https://two.example/b"].map((text) => row(text)),
      COLS,
    );

    expect(links.map((link) => link.url)).toEqual(["https://two.example/b", first]);
  });

  it("does not join a hard-wrap tail into a short unpadded row (reviewer repro, unpadded rows)", () => {
    const links = extractTerminalLinks(
      [row("Auth complete: https://example.com/done"), row("Now run npm install to continue")],
      COLS,
    );

    expect(links).toEqual([{ url: "https://example.com/done", hostname: "example.com" }]);
  });
});

describe("areTerminalLinksEqual", () => {
  it("compares ordered exact URLs only", () => {
    expect(
      areTerminalLinksEqual(
        [{ url: "https://example.com", hostname: "old-label" }],
        [{ url: "https://example.com", hostname: "new-label" }],
      ),
    ).toBe(true);
    expect(
      areTerminalLinksEqual(
        [{ url: "https://example.com", hostname: "example.com" }],
        [{ url: "https://other.example", hostname: "other.example" }],
      ),
    ).toBe(false);
  });
});
