/** 本机桌宠设置页的素材根头像存取。 */
import { existsSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RouteRequest, RouteResult } from './route-contract';
import { ID_FORBIDDEN } from './config';

const MAX_AVATAR_BYTES = 768 * 1024;
const AVATAR_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;
const MIME: Record<(typeof AVATAR_EXTS)[number], string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

function extension(bytes: Buffer): (typeof AVATAR_EXTS)[number] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return '.gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return undefined;
}

function avatarPath(directory: string, root: string, ext: string): string {
  return join(directory, `${root}-avatar${ext}`);
}

/** 处理设置页头像读取与上传；头像和动画配置共用素材根，但不写入 JSON 配置。 */
export function handlePetAvatarRoute(
  request: RouteRequest,
  petConfigDir: string,
): RouteResult | undefined {
  if (request.rest !== 'pet-avatar') return undefined;
  const root = request.query?.get('root')?.trim() ?? '';
  if (!root || root.length > 64 || ID_FORBIDDEN.test(root)) {
    return { kind: 'json', status: 400, obj: { ok: false, message: '素材根不合法。' } };
  }

  if (request.method === 'GET') {
    let selected: { file: string; ext: (typeof AVATAR_EXTS)[number]; mtime: number } | undefined;
    for (const ext of AVATAR_EXTS) {
      const file = avatarPath(petConfigDir, root, ext);
      if (!existsSync(file)) continue;
      try {
        if (lstatSync(file).isSymbolicLink()) continue;
        const mtime = statSync(file).mtimeMs;
        if (!selected || mtime > selected.mtime) selected = { file, ext, mtime };
      } catch { /* 文件刚好被替换时继续探测其它格式。 */ }
    }
    return selected
      ? { kind: 'file', file: selected.file, contentType: MIME[selected.ext] }
      : { kind: 'text', status: 404, body: '头像尚未设置。' };
  }

  if (request.method !== 'POST') return { kind: 'json', status: 405, obj: { ok: false, message: '仅支持 GET 或 POST。' } };

  let payload: unknown;
  try { payload = JSON.parse(request.body ?? ''); }
  catch { return { kind: 'json', status: 400, obj: { ok: false, message: '上传数据格式无效。' } }; }
  const encoded = payload && typeof payload === 'object' ? (payload as { base64?: unknown }).base64 : undefined;
  if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_AVATAR_BYTES * 4 / 3) + 4) {
    return { kind: 'json', status: 413, obj: { ok: false, message: '头像文件超过 768 KiB。' } };
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== encoded) {
    return { kind: 'json', status: 400, obj: { ok: false, message: '图片数据无效。' } };
  }
  if (bytes.length > MAX_AVATAR_BYTES) return { kind: 'json', status: 413, obj: { ok: false, message: '头像文件超过 768 KiB。' } };
  const ext = extension(bytes);
  if (!ext) return { kind: 'json', status: 415, obj: { ok: false, message: '仅支持 PNG、JPEG、WebP 或 GIF。' } };

  const target = avatarPath(petConfigDir, root, ext);
  try { mkdirSync(petConfigDir, { recursive: true, mode: 0o700 }); }
  catch { return { kind: 'json', status: 500, obj: { ok: false, message: '本机素材目录无法写入。' } }; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
    for (const other of AVATAR_EXTS) {
      if (other === ext) continue;
      try { unlinkSync(avatarPath(petConfigDir, root, other)); }
      catch { /* 不存在或正被读取的旧格式不影响本次上传。 */ }
    }
    return { kind: 'json', status: 200, obj: { ok: true } };
  } catch {
    try { unlinkSync(temporary); } catch { /* 临时文件不存在或无法清理。 */ }
    return { kind: 'json', status: 500, obj: { ok: false, message: '头像保存失败，请检查本机数据目录权限。' } };
  }
}
