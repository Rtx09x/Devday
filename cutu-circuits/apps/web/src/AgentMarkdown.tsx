import React, { memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Explicit links only; generated text cannot request local resources or execute URLs. */
export function safeMarkdownUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
}
const plugins = [remarkGfm];
const components = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Provider prose is not authority to fetch remote/tracking images.
  img: () => null,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="agent-table-scroll">
      <table>{children}</table>
    </div>
  ),
};

/** Streaming parses at most 12.5 times/second; completed messages are memoized. */
export const AgentMarkdown = memo(function AgentMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const latest = useRef(text);
  latest.current = text;
  const [display, setDisplay] = useState(text);
  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setDisplay(latest.current), 80);
    return () => window.clearInterval(timer);
  }, [streaming]);
  const content = streaming ? display : text;
  return (
    <div className="agent-markdown" aria-busy={streaming}>
      <Markdown
        skipHtml
        remarkPlugins={plugins}
        components={components}
        urlTransform={safeMarkdownUrl}
      >
        {content}
      </Markdown>
    </div>
  );
});
