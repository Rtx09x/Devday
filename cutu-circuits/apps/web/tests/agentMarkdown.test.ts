import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMarkdown, safeMarkdownUrl } from "../src/AgentMarkdown";

test("assistant markdown renders readable structured content and preserves source tokens", () => {
  const html = renderToStaticMarkup(
    createElement(AgentMarkdown, {
      text: "# Wiring\n\n**Check pins** [S1]\n\n- D5: `GPIO14`\n- D6: `GPIO12`\n\n```cpp\nservo.attach(14);\n```\n\n| Pin | GPIO |\n| --- | --- |\n| D7 | 13 |\n\n[Datasheet](https://example.com/pinout)",
    }),
  );
  assert.match(html, /<h1>Wiring<\/h1>/);
  assert.match(html, /<strong>Check pins<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>D5:/);
  assert.match(html, /<pre><code class="language-cpp">/);
  assert.match(html, /<table>/);
  assert.match(html, /\[S1\]/);
  assert.match(html, /rel="noopener noreferrer"/);
});
test("assistant markdown drops raw HTML and remote images, and strips unsafe links", () => {
  const html = renderToStaticMarkup(
    createElement(AgentMarkdown, {
      text: '<script>alert(1)</script>\n\n<img src="x" onerror="alert(1)">\n\n![tracker](https://example.com/tracking.png)\n\n[bad](javascript:alert%281%29) [file](file:///private) [data](data:text/html,hello) [relative](/api/private)',
    }),
  );
  assert.doesNotMatch(html, /<script|<img|onerror|href=/i);
  for (const raw of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///private",
    "//example.com",
    "/api/private",
    "https://user:password@example.com",
  ])
    assert.equal(safeMarkdownUrl(raw), "");
  assert.equal(
    safeMarkdownUrl("https://example.com/pins"),
    "https://example.com/pins",
  );
});
