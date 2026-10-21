import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteRequest, RouteResult } from './route-contract';

export interface AssetRouteDependencies {
  packageRoot: string;
  petConfigDir: string;
  thumbUserRoot: string;
  idForbidden: RegExp;
  resolveAsset(root: string, rel: string): string | undefined;
  resolveExisting(root: string, rel: string): string | undefined;
  memeDirsFor(assetRoot: string): string[];
}

const MIME: Record<string, string> = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function animSubdirFor(ext: string): string {
  return ext === '.mov' ? 'mov' : 'webm';
}

function assetRootFor(packageRoot: string, ext: string): string {
  return join(packageRoot, 'assets', animSubdirFor(ext));
}

function userRootFor(thumbUserRoot: string, ext: string): string {
  return join(thumbUserRoot, animSubdirFor(ext));
}

function contentTypeOf(file: string): string {
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

function handleAssetRoute(rest: string, deps: AssetRouteDependencies): RouteResult {
  // font and pic are flat routes; only thumb has an additional pet id segment.
  const [scope, ...restParts] = rest.split('/');
  if (scope === 'font') {
    const fontRoot = join(deps.packageRoot, 'assets', 'fonts');
    const fontFile = deps.resolveExisting(fontRoot, restParts.join('/'));
    if (fontFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: font not found' };
    return { kind: 'file', file: fontFile, contentType: contentTypeOf(fontFile) };
  }

  if (scope === 'pic') {
    if (restParts[0] === 'memes') {
      const segs = restParts.slice(1);
      const scoped = segs.length >= 2;
      const assetRoot = scoped ? segs[0] : 'main';
      if (scoped && (assetRoot.length > 64 || deps.idForbidden.test(assetRoot))) {
        return { kind: 'text', status: 400, body: 'dsh-pet: invalid asset root' };
      }
      const rel = (scoped ? segs.slice(1) : segs).join('/');
      let picFile: string | undefined;
      for (const dir of deps.memeDirsFor(assetRoot)) {
        picFile = deps.resolveExisting(dir, rel);
        if (picFile !== undefined) break;
      }
      if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
      return { kind: 'file', file: picFile, contentType: contentTypeOf(picFile) };
    }

    const picRoot = join(deps.packageRoot, 'assets', 'pic');
    const picFile = deps.resolveExisting(picRoot, restParts.join('/'));
    if (picFile === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: pic not found' };
    return { kind: 'file', file: picFile, contentType: contentTypeOf(picFile) };
  }

  if (scope !== 'thumb') {
    return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
  }

  // thumb is /thumb/<petId>/<file>; validate the decoded pet id before any path join.
  const [petId, ...nameParts] = restParts;
  if (!petId || nameParts.length === 0) {
    return { kind: 'text', status: 400, body: 'dsh-pet: expected /dsh-pet-7340/thumb/<petId>/<file>' };
  }
  if (deps.idForbidden.test(petId)) {
    return { kind: 'text', status: 400, body: 'dsh-pet: invalid pet id' };
  }

  const fileName = nameParts.join('/');
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  if (ext !== '.webm' && ext !== '.mov') {
    return {
      kind: 'text',
      status: 400,
      body: 'dsh-pet: unsupported animation format (expected .webm or .mov)',
    };
  }

  const extraAnimDir = deps.resolveAsset(deps.petConfigDir, petId + '-animation');
  const findAnim = (format: string): string | undefined => {
    const name = fileName.replace(/\.(webm|mov)$/i, '') + format;
    return extraAnimDir !== undefined && existsSync(extraAnimDir)
      ? deps.resolveExisting(extraAnimDir, name)
      : (deps.resolveExisting(userRootFor(deps.thumbUserRoot, format), name) ??
          deps.resolveExisting(assetRootFor(deps.packageRoot, format), name));
  };
  let file = findAnim(ext);
  let servedExt = ext;
  if (file === undefined && ext === '.mov') {
    file = findAnim('.webm');
    if (file !== undefined) servedExt = '.webm';
  }
  if (file === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: asset not found' };
  return { kind: 'file', file, contentType: MIME[servedExt] ?? 'application/octet-stream' };
}

/** Build the final asset fallback handler; it also preserves the existing unknown-route response. */
export function createAssetRoute(deps: AssetRouteDependencies): (request: RouteRequest) => RouteResult {
  return ({ rest }) => handleAssetRoute(rest, deps);
}
