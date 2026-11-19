import type { Project } from '../domain/schema';

/** Game distributions carry player-facing content, never the author's private notes. */
export function prepareGameProject(project: Project): Project {
  const {
    worldSettings: _worldSettings,
    productionShots: _productionShots,
    storyDesign: _storyDesign,
    screenplays: _screenplays,
    ...game
  } = project;
  const {
    artStyle: _artStyle,
    atmosphereTone: _atmosphereTone,
    creativeDefaults: _creativeDefaults,
    ...settings
  } = game.settings;
  return {
    ...game,
    settings,
    scenes: game.scenes.map(
      ({ settingIds: _settingIds, storyboardScreenplayVersion: _version, ...scene }) => ({
        ...scene,
        notes: '',
      }),
    ),
  };
}
