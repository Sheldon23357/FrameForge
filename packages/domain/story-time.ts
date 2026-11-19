export const storyTimeStepMs = 100;

/** Snap authored cues, keeping an in-range time inside a fractional clip ending. */
export function snapStoryTime(ms: number, durationMs: number): number {
  const snapped = Math.round(ms / storyTimeStepMs) * storyTimeStepMs;
  return ms <= durationMs && snapped > durationMs
    ? Math.floor(durationMs / storyTimeStepMs) * storyTimeStepMs
    : snapped;
}
