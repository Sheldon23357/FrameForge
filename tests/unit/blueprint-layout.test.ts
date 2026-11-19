import { expect, it } from 'vitest';
import { arrangeBlueprint } from '../../packages/domain/blueprint-layout';
import { makeChoice, makeProject, makeScene } from '../../packages/domain/schema';

it('places each merge after its longest incoming route and ignores hidden fallback links', () => {
  const project = makeProject();
  const [start] = project.scenes;
  const [left, right, merge, preEnding, detached] = Array.from({ length: 5 }, (_, i) =>
    makeScene('video', i + 2, start.chapterId),
  );
  const ending = makeScene('ending', 7, start.chapterId);
  start.choices = [left, right, merge].map((target) => ({
    ...makeChoice(),
    targetId: target.id,
  }));
  start.nextId = ending.id;
  left.nextId = right.nextId = merge.id;
  merge.nextId = preEnding.id;
  preEnding.nextId = ending.id;
  project.scenes.push(ending, merge, right, detached, preEnding, left);
  const layout = arrangeBlueprint(project, null);
  const x = (id: string) => layout[id].x;
  expect(x(left.id)).toBe(x(right.id));
  expect(layout[left.id].y).toBeLessThan(layout[right.id].y);
  expect(x(merge.id)).toBeGreaterThan(x(left.id));
  expect(x(ending.id)).toBeGreaterThan(x(preEnding.id));
  expect(layout[detached.id].y).toBeGreaterThan(layout[right.id].y);
  expect(arrangeBlueprint(project, start.chapterId)).toEqual(layout);
});

it('lays out loops without losing their exits and leaves other chapters out of the result', () => {
  const project = makeProject();
  const [start] = project.scenes;
  const loop = makeScene('video', 2, start.chapterId);
  const outside = makeScene('ending', 3, 'another_chapter');
  start.nextId = loop.id;
  loop.choices = [start, outside].map((target) => ({ ...makeChoice(), targetId: target.id }));
  project.scenes.push(loop, outside);
  const all = arrangeBlueprint(project, null);
  expect(all[start.id].x).toBeLessThan(all[loop.id].x);
  expect(all[loop.id].x).toBeLessThan(all[outside.id].x);
  expect(Object.keys(arrangeBlueprint(project, start.chapterId))).toEqual([start.id, loop.id]);
});
