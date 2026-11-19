import { useLayoutEffect, useRef } from 'react';

export function NodeNotes({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const editor = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = editor.current;
    if (element && element.innerText !== value) element.innerText = value;
  }, [value]);

  return (
    <div className="node-notes-panel">
      <div
        ref={editor}
        className="node-notes-text"
        role="textbox"
        aria-label="节点内容"
        aria-multiline="true"
        contentEditable="plaintext-only"
        data-placeholder={
          value ? undefined : '记录从哪来、已知与持有、这一段新增什么、往哪去，供后续拆分镜。'
        }
        onInput={(e) => onChange(e.currentTarget.innerText)}
      />
    </div>
  );
}
