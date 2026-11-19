import { Asset, Project } from '../../packages/domain/schema';
import type { ExportTarget } from '../../packages/export/web';
import type { AudioAssetCategory } from '../../packages/domain/assets';
import type { AgentSettingsAPI } from '../../packages/agent/settings';
import type { AgentAPI } from '../../packages/agent/types';
import type { AgentSkillsAPI } from '../../packages/agent/skills';
import type { ShotImageRequest } from '../../packages/domain/production-shots';
import type { ImageProvider } from '../../packages/agent/settings';
import type { ProductionAudioRequest } from '../../packages/domain/production-audio';
import type {
  WorldReferenceKind,
  WorldReferenceRequest,
  WorldReferenceStatus,
} from '../../packages/domain/world-settings';
export interface BootResult {
  project: Project;
  mode: 'editor' | 'player';
  filePath?: string;
  recovered?: boolean;
  ffmpeg: boolean;
}
export interface DesktopBridge {
  agentSettings: AgentSettingsAPI;
  agentSkills: AgentSkillsAPI;
  agent: AgentAPI;
  bootstrap(): Promise<BootResult>;
  openProject(): Promise<BootResult | null>;
  openProjectWindow(): Promise<void>;
  saveProject(project: Project, saveAs?: boolean): Promise<string | null>;
  autosave(project: Project, requireWrite?: boolean): Promise<void>;
  defaultProjectDirectory(title: string): Promise<string>;
  chooseProjectDirectory(): Promise<string | null>;
  newProject(project: Project, directory?: string): Promise<string>;
  ensureVersionAssets(project: Project, ids: string[]): Promise<void>;
  importAssets(kind?: WorldReferenceKind, audioCategory?: AudioAssetCategory): Promise<Asset[]>;
  stageAssetImport(
    projectId: string,
    audioCategory?: AudioAssetCategory,
    operationId?: string,
  ): Promise<Asset[]>;
  generateWorldReference(
    input: { projectId: string; requestId: string } & (
      | { reference: WorldReferenceRequest; imageProvider?: ImageProvider }
      | { shotImage: ShotImageRequest; imageProvider?: ImageProvider }
      | { productionAudio: ProductionAudioRequest }
    ),
  ): Promise<Asset>;
  cancelWorldReference(id: string): Promise<void>;
  onWorldReferenceStatus(callback: (id: string, status: WorldReferenceStatus) => void): () => void;
  exportGame(project: Project, target?: ExportTarget): Promise<string | null>;
  reveal(path: string): Promise<void>;
  revealAsset(projectId: string, assetId: string): Promise<void>;
  assetUrl(id: string, thumbnail?: boolean): string;
  onBeforeClose(callback: () => void): () => void;
  completeClose(saved: boolean): Promise<void>;
}
declare global {
  interface Window {
    frameforge?: DesktopBridge;
  }
}
