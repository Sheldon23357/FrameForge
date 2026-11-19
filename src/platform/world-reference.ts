import type { GenerateWorldReference } from '../../packages/domain/world-settings';
import type { GenerateShotImage } from '../../packages/domain/production-shots';
import type { GenerateProductionAudio } from '../../packages/domain/production-audio';
import type { DesktopBridge } from './types';
import type { ImageProvider } from '../../packages/agent/settings';

async function generateMedia(
  input: Parameters<DesktopBridge['generateWorldReference']>[0],
  signal: AbortSignal,
  durable: boolean,
  onStatus?: Parameters<GenerateWorldReference>[3],
) {
  const bridge = window.frameforge;
  if (!bridge) throw new Error('请在桌面版生成参考素材。');
  signal.throwIfAborted();
  const { requestId } = input;
  const unsubscribe =
    onStatus &&
    bridge.onWorldReferenceStatus((id, status) => {
      if (id === requestId) onStatus(status);
    });
  const cancel = () => void bridge.cancelWorldReference(requestId).catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const asset = await bridge.generateWorldReference(input);
    // Durable jobs must return their result even when cancellation raced with completion.
    if (!durable) signal.throwIfAborted();
    return asset;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error(error.message.replace(/^Error invoking remote method '[^']+': Error:\s*/, ''));
  } finally {
    unsubscribe?.();
    signal.removeEventListener('abort', cancel);
  }
}

export const generateWorldReference: (
  ...args: [...Parameters<GenerateWorldReference>, ImageProvider?]
) => ReturnType<GenerateWorldReference> = (
  projectId,
  reference,
  signal,
  onStatus,
  operationId,
  imageProvider?: ImageProvider,
) =>
  generateMedia(
    { projectId, reference, imageProvider, requestId: operationId ?? crypto.randomUUID() },
    signal,
    Boolean(operationId),
    onStatus,
  );

export const generateShotImage: (
  ...args: [...Parameters<GenerateShotImage>, ImageProvider?]
) => ReturnType<GenerateShotImage> = (
  projectId,
  shotImage,
  signal,
  requestId,
  imageProvider?: ImageProvider,
) => generateMedia({ projectId, shotImage, requestId, imageProvider }, signal, true);

export const generateProductionAudio: GenerateProductionAudio = (
  projectId,
  productionAudio,
  signal,
  requestId,
) => generateMedia({ projectId, productionAudio, requestId }, signal, true);
