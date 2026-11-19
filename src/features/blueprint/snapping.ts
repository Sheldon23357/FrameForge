export const GRID_SIZE = 24;
export const SNAP_GRID: [number, number] = [GRID_SIZE, GRID_SIZE];
export interface SnapNode {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
}
export interface AlignmentGuide {
  axis: 'x' | 'y';
  value: number;
  from: number;
  to: number;
}

/** Align edges and centres in flow coordinates; exclude the whole dragged group. */
export function snapToNodes(
  moving: SnapNode,
  nodes: SnapNode[],
  excluded: Set<string>,
  threshold: number,
) {
  const size = (node: SnapNode) => ({
    width: node.measured?.width ?? 254,
    height: node.measured?.height ?? 300,
  });
  const movingSize = size(moving);
  let dx = 0,
    dy = 0;
  let nearestX = threshold,
    nearestY = threshold;
  let xGuide: AlignmentGuide | undefined, yGuide: AlignmentGuide | undefined;
  for (const peer of nodes) {
    if (peer.id === moving.id || excluded.has(peer.id)) continue;
    const peerSize = size(peer);
    for (const axis of ['x', 'y'] as const) {
      const dimension = axis === 'x' ? 'width' : 'height';
      for (const ownOffset of [0, movingSize[dimension] / 2, movingSize[dimension]]) {
        for (const peerOffset of [0, peerSize[dimension] / 2, peerSize[dimension]]) {
          const value = peer.position[axis] + peerOffset;
          const delta = value - moving.position[axis] - ownOffset;
          if (Math.abs(delta) >= (axis === 'x' ? nearestX : nearestY)) continue;
          const guide: AlignmentGuide =
            axis === 'x'
              ? {
                  axis,
                  value,
                  from: Math.min(moving.position.y, peer.position.y) - 24,
                  to:
                    Math.max(
                      moving.position.y + movingSize.height,
                      peer.position.y + peerSize.height,
                    ) + 24,
                }
              : {
                  axis,
                  value,
                  from: Math.min(moving.position.x, peer.position.x) - 24,
                  to:
                    Math.max(
                      moving.position.x + movingSize.width,
                      peer.position.x + peerSize.width,
                    ) + 24,
                };
          if (axis === 'x') {
            nearestX = Math.abs(delta);
            dx = delta;
            xGuide = guide;
          } else {
            nearestY = Math.abs(delta);
            dy = delta;
            yGuide = guide;
          }
        }
      }
    }
  }
  return { dx, dy, guides: [xGuide, yGuide].filter((g): g is AlignmentGuide => !!g) };
}
