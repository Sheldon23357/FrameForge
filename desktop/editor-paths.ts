import path from 'node:path';
import { app } from 'electron';

export function editorWorkspaceDirectory() {
  if (!app.isPackaged) return app.getAppPath();
  const executableDirectory = path.dirname(app.getPath('exe'));
  const releaseDirectory = path.dirname(executableDirectory);
  if (
    /^win(?:-[a-z0-9]+)?-unpacked$/i.test(path.basename(executableDirectory)) &&
    path.basename(releaseDirectory).toLowerCase() === 'release'
  ) {
    return path.dirname(releaseDirectory);
  }
  return executableDirectory;
}
