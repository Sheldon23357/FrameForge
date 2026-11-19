import { useLayoutEffect, useRef, useState } from 'react';
import AgentMarkdown from '../agent/AgentMarkdown';

interface Heading {
  element: HTMLHeadingElement;
  label: string;
  level: number;
}

export default function StoryDesignPreview({ text, title }: { text: string; title?: string }) {
  const reading = useRef<HTMLDivElement>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);

  useLayoutEffect(() => {
    const elements = reading.current?.querySelectorAll<HTMLHeadingElement>(
      '.story-design-markdown :is(h1, h2, h3, h4, h5, h6)',
    );
    const entries = Array.from(elements ?? []).flatMap((element) => {
      const label = element.innerText.trim().replace(/\s+/g, ' ');
      if (!label) return [];
      element.tabIndex = -1;
      return [{ element, label, level: Number(element.tagName[1]) }];
    });
    setHeadings(entries);
  }, [text]);

  const firstLevel = Math.min(...headings.map(({ level }) => level));

  const jumpTo = (element: HTMLHeadingElement) => {
    const container = reading.current;
    if (!container) return;
    const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTo({ top: container.scrollTop + offset - 16 });
    element.focus({ preventScroll: true });
  };

  return (
    <>
      <div className="story-design-reading" tabIndex={0} aria-label={title} ref={reading}>
        {text.trim() ? (
          <AgentMarkdown text={text} className="story-design-markdown" />
        ) : (
          <p className="story-design-placeholder">还没有正文。切换到编辑即可开始写作。</p>
        )}
      </div>
      {headings.length > 0 && (
        <nav className="story-design-toc" aria-label="标题导航">
          <strong>目录</strong>
          <ol>
            {headings.map(({ element, label, level }, index) => (
              <li key={index}>
                <button
                  type="button"
                  style={{ paddingInlineStart: 8 + (level - firstLevel) * 9 }}
                  onClick={() => jumpTo(element)}
                >
                  {label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </>
  );
}
