const markdownItFactory = globalThis.markdownit;

if (typeof markdownItFactory !== "function") {
  throw new Error("Markdown renderer failed to load");
}

const markdown = markdownItFactory({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

const renderLinkOpen = markdown.renderer.rules.link_open
  || ((tokens, index, options, environment, renderer) => (
    renderer.renderToken(tokens, index, options)
  ));

markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  const href = tokens[index].attrGet("href") || "";
  if (/^(https?:|mailto:)/i.test(href)) {
    tokens[index].attrSet("target", "_blank");
    tokens[index].attrSet("rel", "noopener noreferrer");
  }
  return renderLinkOpen(tokens, index, options, environment, renderer);
};

markdown.renderer.rules.table_open = () => '<div class="markdown-table-scroll"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";

const renderedSources = new WeakMap();

export function renderMarkdown(text) {
  return markdown.render(String(text || ""));
}

export function renderMarkdownInto(element, text) {
  const source = String(text || "");
  if (renderedSources.get(element) === source) return;
  element.innerHTML = renderMarkdown(source);
  renderedSources.set(element, source);
}
