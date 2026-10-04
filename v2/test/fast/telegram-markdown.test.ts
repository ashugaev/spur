import { describe, expect, it } from "vitest";
import { renderTelegramHtml } from "../../src/telegram-markdown.js";

const render = (text: string): string => renderTelegramHtml([text])[0] ?? "";

describe("renderTelegramHtml", () => {
  it("renders bold, strike and inline code", () => {
    expect(render("a **bold** and ~~gone~~ and `code`")).toBe(
      "a <b>bold</b> and <s>gone</s> and <code>code</code>",
    );
  });

  it("escapes < and & inside inline code", () => {
    expect(render("use `a < b && c`")).toBe("use <code>a &lt; b &amp;&amp; c</code>");
  });

  it("renders a fence with its language and escapes the body", () => {
    expect(render("```ts\nconst a = 1 < 2;\n```")).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    );
    expect(render("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  it("renders an https link and escapes & in the URL", () => {
    expect(render("see [docs](https://example.com/a?x=1&y=2)")).toBe(
      'see <a href="https://example.com/a?x=1&amp;y=2">docs</a>',
    );
  });

  it("leaves a non-http link literal", () => {
    expect(render("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  });

  it("leaves ftp and file links literal", () => {
    expect(render("[a](ftp://host/f) [b](file:///etc/passwd)")).toBe(
      "[a](ftp://host/f) [b](file:///etc/passwd)",
    );
  });

  it("escapes a quote in a link URL so it cannot break out of href", () => {
    expect(render('[x](https://e.com/a"onclick=1)')).toBe(
      '<a href="https://e.com/a&quot;onclick=1">x</a>',
    );
  });

  it("renders a heading as a bold line", () => {
    expect(render("## Title here\nbody")).toBe("<b>Title here</b>\nbody");
  });

  it("escapes bare <, & and >", () => {
    expect(render("a < b & c > d <b>x</b>")).toBe("a &lt; b &amp; c &gt; d &lt;b&gt;x&lt;/b&gt;");
  });

  it("keeps unmatched markers literal", () => {
    expect(render("an **unclosed bold and a stray ` tick")).toBe(
      "an **unclosed bold and a stray ` tick",
    );
  });

  it("leaves snake_case and single asterisks alone", () => {
    expect(render("call my_func_name with *args")).toBe("call my_func_name with *args");
  });

  it("does not format inside a fence", () => {
    expect(render("```\n**not bold** `x`\n```")).toBe("<pre>**not bold** `x`</pre>");
  });

  it("closes an open fence at a chunk end and reopens it in the next chunk", () => {
    expect(renderTelegramHtml(["```py\nfirst", "second\n```\nafter **b**"])).toEqual([
      '<pre><code class="language-py">first</code></pre>',
      '<pre><code class="language-py">second</code></pre>\nafter <b>b</b>',
    ]);
  });
});
