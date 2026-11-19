import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: ({ children }) => (
    <div className="agent-markdown-table">
      <table>{children}</table>
    </div>
  ),
};

export default memo(function AgentMarkdown({
  text,
  className = '',
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`agent-message-text ${className}`}>
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { output: 'mathml', trust: false }]]}
        components={components}
        urlTransform={(url, key) => (key === 'href' && /^https?:\/\//i.test(url) ? url : '')}
      >
        {text}
      </Markdown>
    </div>
  );
});
