import fs from 'node:fs/promises';
import path from 'node:path';

const imageEndpoint = 'https://api.minimax.cn/v1/images';
const mimeTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export async function generateMiniMaxImage(
  request: (url: string, init?: RequestInit) => Promise<Response>,
  apiKey: string,
  prompt: string,
  references: string[],
  width: number,
  height: number,
  signal: AbortSignal,
) {
  const images: { image_url: string }[] = [];
  let totalBytes = 0;
  for (const file of references) {
    signal.throwIfAborted();
    const mime = mimeTypes[path.extname(file).toLowerCase() as keyof typeof mimeTypes];
    if (!mime) throw new Error('MiniMax 参考图须为 PNG、JPEG 或 WebP。');
    totalBytes += (await fs.stat(file)).size;
    if (totalBytes > 47 * 1024 * 1024)
      throw new Error('参考图总大小超过 MiniMax 请求限制，请缩小图片后再生成。');
    const bytes = await fs.readFile(file, { signal });
    images.push({ image_url: `data:${mime};base64,${bytes.toString('base64')}` });
  }
  let response: Response;
  try {
    response = await request(`${imageEndpoint}/${images.length ? 'edits' : 'generations'}`, {
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'MiniMax-H3-Image',
        prompt,
        size: `${width}x${height}`,
        n: 1,
        output_format: 'png',
        response_format: 'b64_json',
        ...(images.length ? { images } : {}),
      }),
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new Error('MiniMax 生图网络请求失败，提交结果未知。');
  }
  const payload = await response.json().catch(() => null);
  signal.throwIfAborted();
  const entry = payload?.data?.[0];
  const rawCode = entry?.error?.code ?? payload?.error?.code ?? payload?.base_resp?.status_code;
  const code = String(rawCode ?? '');
  if (!response.ok || entry?.error || typeof entry?.b64_json !== 'string' || !entry.b64_json) {
    const reason =
      response.status === 429 || code === '1002'
        ? '触发限流'
        : response.status === 401 || response.status === 403 || code === '1004'
          ? '密钥或模型权限不可用'
          : response.status === 402 || code === '1008'
            ? '余额或生图额度不足'
            : response.status === 422 || code === '1027'
              ? '内容未通过审核'
              : '未返回有效图片';
    const detail = /^[a-z0-9_-]{1,50}$/i.test(code) ? `，错误代码 ${code}` : '';
    throw new Error(`MiniMax 生图失败：${reason}（HTTP ${response.status}${detail}）。`);
  }
  return Buffer.from(entry.b64_json, 'base64');
}
