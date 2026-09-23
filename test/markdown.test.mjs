import assert from "node:assert/strict";
import test from "node:test";
import MarkdownIt from "markdown-it";

globalThis.markdownit = MarkdownIt;
const { renderMarkdown, renderMarkdownInto } = await import("../public/markdown.js");

test("renders conversation Markdown with mobile-safe tables and external links", () => {
  const html = renderMarkdown(`
### 标题

**粗体**、\`inline\` 和 [文档](https://example.com/docs)。

- 第一项
- 第二项

| 字段 | 默认值 |
| --- | --- |
| 平台 | Instagram |

\`\`\`js
const value = "<safe>";
\`\`\`
`);

  assert.match(html, /<h3>标题<\/h3>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /class="markdown-table-scroll"/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /&lt;safe&gt;/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("keeps raw thread content inert and rejects unsafe link protocols", () => {
  const html = renderMarkdown(`
<in-app-browser-context onmouseover="alert(1)">ambient</in-app-browser-context>

<script>alert("xss")</script>

[unsafe](javascript:alert(1))
`);

  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<[^>]+onmouseover=/i);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /&lt;in-app-browser-context/);
  assert.match(html, /&lt;script&gt;/);
});

test("re-renders accumulated streaming text instead of individual deltas", () => {
  const body = { innerHTML: "" };
  renderMarkdownInto(body, "**bo");
  assert.doesNotMatch(body.innerHTML, /<strong>/);
  renderMarkdownInto(body, "**bold**");
  assert.match(body.innerHTML, /<strong>bold<\/strong>/);

  const longMessage = `${"内容 ".repeat(12_500)}\n\n- 完成`;
  renderMarkdownInto(body, longMessage);
  assert.match(body.innerHTML, /<li>完成<\/li>/);
});
