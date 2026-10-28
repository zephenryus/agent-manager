import assert from "node:assert/strict";
import { test } from "node:test";
import { renderBoard, renderInline, renderMarkdown } from "../public/markdown.js";

test("raw HTML is escaped everywhere", () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(1)</script>';
  for (const html of [renderMarkdown(evil), renderMarkdown(`# ${evil}`), renderMarkdown(`- ${evil}`), renderMarkdown(`| ${evil} |\n|---|\n| ${evil} |`), renderMarkdown("```\n" + evil + "\n```"), renderInline(evil)]) {
    assert.ok(!/<img|<script/i.test(html), html);
    assert.match(html, /&lt;/);
  }
});

test("links and images are not rendered", () => {
  const html = renderMarkdown("[click](javascript:alert(1)) ![x](http://a/b.png)");
  assert.ok(!html.includes("<a") && !html.includes("<img"));
});

test("inline: bold, italic, code (and no markup inside code)", () => {
  assert.equal(renderInline("a **b** and *c* and `d`"), "a <strong>b</strong> and <em>c</em> and <code>d</code>");
  assert.equal(renderInline("`**not bold**`"), "<code>**not bold**</code>");
  assert.equal(renderInline("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(renderInline("snake_case_name"), "snake_case_name");
});

test("headings map to the base level and cap at h6", () => {
  assert.equal(renderMarkdown("# One"), "<h3>One</h3>");
  assert.equal(renderMarkdown("## Two"), "<h4>Two</h4>");
  assert.equal(renderMarkdown("# One", { headingBase: 2 }), "<h2>One</h2>");
  assert.equal(renderMarkdown("#### Deep", { headingBase: 5 }), "<h6>Deep</h6>");
});

test("lists: bullets and numbers, grouped", () => {
  assert.equal(renderMarkdown("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(renderMarkdown("1. a\n2) b"), "<ol><li>a</li><li>b</li></ol>");
  assert.equal(renderMarkdown("- a\n\ntext"), "<ul><li>a</li></ul>\n<p>text</p>");
});

test("paragraphs keep single line breaks and split on blank lines", () => {
  assert.equal(renderMarkdown("one\ntwo\n\nthree"), "<p>one<br>two</p>\n<p>three</p>");
});

test("a paragraph stops where a list or heading starts", () => {
  assert.equal(renderMarkdown("intro\n- a"), "<p>intro</p>\n<ul><li>a</li></ul>");
  assert.equal(renderMarkdown("intro\n## H"), "<p>intro</p>\n<h4>H</h4>");
});

test("tables", () => {
  const html = renderMarkdown("| Q | Evidence |\n|---|---|\n| Is it real? | **Compare** |\n| How often? |");
  assert.match(html, /<th>Q<\/th><th>Evidence<\/th>/);
  assert.match(html, /<td>Is it real\?<\/td><td><strong>Compare<\/strong><\/td>/);
  assert.match(html, /<td>How often\?<\/td><td><\/td>/, "short rows are padded");
  assert.match(html, /^<div class="table-wrap"><table>/);
});

test("a pipe line without a separator row is just text", () => {
  assert.equal(renderMarkdown("a | b"), "<p>a | b</p>");
});

test("code fences keep their text and survive an unclosed fence", () => {
  assert.equal(renderMarkdown("```\n<b>x</b>\n  y\n```"), "<pre><code>&lt;b&gt;x&lt;/b&gt;\n  y</code></pre>");
  assert.equal(renderMarkdown("```\nopen"), "<pre><code>open</code></pre>");
});

test("never hangs on odd input", () => {
  for (const s of ["", "\n\n", "|", "|\n|", "---", "* ", "#", "# ", "\u0000", "```", "**", "`"]) renderMarkdown(s);
  assert.equal(renderMarkdown(""), "");
});

test("NUL characters in input cannot forge code spans", () => {
  assert.ok(!renderInline("\u00000\u0000 `x`").includes("<code>\u0000"));
});

test("boards: goal lines become status rows; other lines render normally", () => {
  const html = renderBoard(
    "# PI board\n\n## Goals\n- PI-1 [active] Shorten time to insight | owner: research-lead\n- PI-2 [proposed] <b>x</b>\n- plain bullet\n\n## Notes\nSample.",
  );
  assert.match(html, /^<h2>PI board<\/h2>/);
  assert.match(html, /<li class="item" data-status="active" data-id="PI-1">/);
  assert.match(html, /<span class="item-id">PI-1<\/span>/);
  assert.match(html, /<span class="field"><b>owner<\/b> research-lead<\/span>/);
  assert.match(html, /data-status="proposed"/);
  assert.ok(!html.includes("<b>x</b>"));
  assert.match(html, /<li>plain bullet<\/li>/);
  assert.match(html, /<h3>Notes<\/h3>/);
});

test("a parent that is an item id becomes a jump button; other parents stay text", () => {
  const html = renderBoard("- SP-1 [active] Mid | parent: PI-1\n- PI-1 [active] Top | parent: Q4\n- SP-2 [active] Odd | parent: <b>x</b>");
  assert.match(html, /<button type="button" class="goto" data-goto="PI-1">PI-1<\/button>/);
  assert.match(html, /<b>parent<\/b> Q4<\/span>/);
  assert.ok(!html.includes("<b>x</b>"));
  assert.equal((html.match(/class="goto"/g) ?? []).length, 1);
});
