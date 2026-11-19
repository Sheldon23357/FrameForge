import { Asset } from '../../packages/domain/schema';
import { browserPlatform, browserAssetUrl } from './browser';
export const isDesktop = !!window.frameforge;
export const platform = window.frameforge ?? browserPlatform;
export function assetUrl(a: Asset | undefined, thumbnail = false): string {
  if (!a) return '';
  if (thumbnail && a.thumbnail?.startsWith('data:')) return a.thumbnail;
  return window.frameforge
    ? window.frameforge.assetUrl(a.id, thumbnail)
    : browserAssetUrl(a, thumbnail);
}
