import type { Project } from '../domain/schema';

export type ExportTarget = 'windows' | 'web';

export function webAssetPath(relative: string): string {
  const normalized = relative.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.includes(':') ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('网页版素材路径无效。');
  return normalized;
}

export function webAssetPaths(project: Project): string[] {
  return [...new Set(project.assets.flatMap((asset) => [asset.path, asset.thumbnail]))]
    .filter((path): path is string => !!path && !path.startsWith('data:'))
    .map(webAssetPath);
}

export const webInstructions = `网页版游戏部署说明

1. 将本目录中的全部文件上传到网站目录，保持 index.html、assets、game 的相对位置。
2. 通过 HTTP 或 HTTPS 访问该目录，例如 https://example.com/games/my-story/。
   可以部署在域名根目录或子目录，无需 Node.js、数据库或专用游戏后端。
3. 点击“开始游戏”进入游戏。浏览器可能要求点击播放按钮后才允许播放有声视频。
   游玩时按住 Ctrl 以 10 倍速播放，松开恢复正常速度。
4. 存档保存在玩家当前浏览器的本地存储中，不会同步到其他设备；清除网站数据会删除存档。

服务器需正常提供 .html、.js、.css、.json、字体和媒体文件，建议支持视频 Range 请求。
请使用浏览器支持的媒体编码（例如 MP4 / H.264 + AAC）；导出不会转码原素材。
不要用 file:// 直接双击 index.html；本地测试请启动静态 HTTP 服务。
使用内置示例素材时，授权说明见 game/files/demo/CREDITS.txt。
`;
