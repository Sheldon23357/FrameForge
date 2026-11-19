/** Compact automatic context. The original notes remain available in the editor and by page. */
export function projectNotePreview(notes: string) {
  const first = notes.trim().replace(/^\[S\d+\s*·[^\]\n]+\]\s*/, '');
  const paragraphs = first.split(/\n\s*\n/, 1)[0];
  return paragraphs.replace(/\s+/g, ' ').slice(0, 240);
}
