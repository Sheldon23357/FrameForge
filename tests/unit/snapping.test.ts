import { describe, it, expect } from 'vitest';
import { snapToNodes } from '../../src/features/blueprint/snapping';
const node = (id: string, x: number, y: number) => ({
  id,
  position: { x, y },
  measured: { width: 100, height: 80 },
});
describe('blueprint alignment', () => {
  it('aligns a nearby left edge and emits a vertical guide', () => {
    const moving = node('moving', 96, 300);
    const result = snapToNodes(moving, [moving, node('peer', 100, 0)], new Set(['moving']), 8);
    expect(result.dx).toBe(4);
    expect(result.dy).toBe(0);
    expect(result.guides[0]).toMatchObject({ axis: 'x', value: 100 });
  });
  it('aligns edges and centres independently using the closest matches', () => {
    const moving = node('moving', 151, 82);
    const result = snapToNodes(moving, [node('peer', 100, 0)], new Set(['moving']), 8);
    expect(result.dx).toBe(-1);
    expect(result.dy).toBe(-2);
    expect(result.guides).toHaveLength(2);
  });
  it('excludes every member of a dragged group', () => {
    const moving = node('moving', 96, 300);
    expect(snapToNodes(moving, [node('group', 100, 300)], new Set(['moving', 'group']), 8)).toEqual(
      { dx: 0, dy: 0, guides: [] },
    );
  });
  it('does not move a node outside the attraction radius', () => {
    const result = snapToNodes(node('moving', 20, 300), [node('peer', 100, 0)], new Set(), 8);
    expect(result).toEqual({ dx: 0, dy: 0, guides: [] });
  });
});
