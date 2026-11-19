export const projectAspectPresets = {
  '16:9': { label: '横屏 · 16:9', width: 1920, height: 1080 },
  '9:16': { label: '竖屏 · 9:16', width: 1080, height: 1920 },
} as const;

export function projectAspect(
  width: number,
  height: number,
): keyof typeof projectAspectPresets | undefined {
  if (width * 9 === height * 16) return '16:9';
  if (width * 16 === height * 9) return '9:16';
}
