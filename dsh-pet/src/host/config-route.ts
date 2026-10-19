import { mkdir, writeFile } from 'node:fs/promises';
import type { ConfigPaths } from './config';
import {
  flattenPetList,
  findPetInstance,
  PET_DISPLAY_SET,
  readAllConfig,
  readPetConfigEntry,
  readUserConfig,
  saveUserConfig,
  syncUserConfigFromDefault,
  userConfigUnparsable,
} from './config';
import type { RouteRequest, RouteResult } from './route-contract';

type ConfigRecord = Record<string, Record<string, unknown>>;

export interface ConfigRouteDependencies {
  userRoot: string;
  userConfigPath: string;
  petConfigDir: string;
  findPetConfigEntry: (entry: string) => ReturnType<typeof readPetConfigEntry>;
  readAll: () => ConfigRecord;
  readUser: () => Record<string, unknown> | undefined;
  userUnparsable: () => boolean;
  syncDefault: () => void;
  writeConfig: (path: string, directory: string, content: string) => Promise<void>;
  writeConfigChanged: () => void;
  reloadDesktop: () => void;
  mapResponseConfig: (config: ConfigRecord) => unknown;
  releasePetLock?: (petId: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Configuration and pet display mutation endpoints, isolated from host lifecycle state. */
export function createConfigRoute(
  deps: ConfigRouteDependencies,
): (request: RouteRequest) => Promise<RouteResult | undefined> {
  const writeConfig = deps.writeConfig;

  return async ({ rest, method, body, query }) => {
    if (rest === 'config') {
      if (method === 'GET') {
        try {
          return {
            kind: 'json',
            status: 200,
            obj: deps.mapResponseConfig(deps.readAll()),
            headers: { 'cache-control': 'no-cache, no-store' },
          };
        } catch (error) {
          return { kind: 'json', status: 500, obj: { error: errorMessage(error) } };
        }
      }

      if (method === 'PUT') {
        try {
          const parsed = JSON.parse(body ?? '');
          const clean = saveUserConfig(parsed, deps.readUser());
          if (!clean) {
            return {
              kind: 'json',
              status: 400,
              obj: {
                error:
                  'invalid pet config: expected { pets:[{name?,id,size,balanceEnabled,display,position:{corner,marginX,marginY}}] }（display 为 desktop/none 之一；可选顶层 notificationsEnabled / whisperImageEnabled / chatImageEnabled 布尔；可选宠物布尔 whisperEnabled / workStatusEnabled / fixedEnabled）',
              },
            };
          }
          if (query?.get('force') !== '1' && deps.userUnparsable()) {
            return {
              kind: 'json',
              status: 409,
              obj: { error: 'user config is unparsable', needConfirm: true, userFile: deps.userConfigPath },
            };
          }
          const previousDisplay = new Map(
            flattenPetList(deps.readAll()).map((pet) => [String(pet.id ?? ''), String(pet.display ?? '')]),
          );
          await writeConfig(deps.userConfigPath, deps.userRoot, JSON.stringify(clean, null, 2));
          const nextDisplay = new Map(
            flattenPetList(deps.readAll()).map((pet) => [String(pet.id ?? ''), String(pet.display ?? '')]),
          );
          for (const [petId, previous] of previousDisplay) {
            if (previous !== 'none' && nextDisplay.get(petId) !== 'desktop') deps.releasePetLock?.(petId);
          }
          deps.reloadDesktop();
          return { kind: 'json', status: 200, obj: deps.mapResponseConfig(deps.readAll()) };
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
      }

      if (method === 'POST') {
        try {
          deps.syncDefault();
        } catch (error) {
          return { kind: 'json', status: 500, obj: { error: errorMessage(error) } };
        }
        deps.reloadDesktop();
        return { kind: 'json', status: 200, obj: deps.mapResponseConfig(deps.readAll()) };
      }
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    if (rest === 'pet-display/bulk') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let payload: { ids?: unknown; display?: unknown };
      try {
        payload = JSON.parse(body ?? '') as { ids?: unknown; display?: unknown };
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const ids = Array.isArray(payload.ids)
        ? [
            ...new Set(
              payload.ids
                .filter((id): id is string => typeof id === 'string')
                .map((id) => id.trim())
                .filter(Boolean),
            ),
          ]
        : [];
      const nextDisplay = String(payload.display ?? '');
      if (!ids.length) return { kind: 'json', status: 400, obj: { error: 'missing pet ids' } };
      if (!PET_DISPLAY_SET.has(nextDisplay)) {
        return { kind: 'json', status: 400, obj: { error: `invalid display: ${nextDisplay}` } };
      }

      let merged: ConfigRecord;
      try {
        merged = deps.readAll();
      } catch (error) {
        return { kind: 'json', status: 500, obj: { error: errorMessage(error) } };
      }
      const groups = new Map<string, Set<string>>();
      for (const id of ids) {
        const hit = findPetInstance(merged, id);
        if (!hit) return { kind: 'json', status: 404, obj: { error: `pet not found: ${id}` } };
        if (!groups.has(hit.entry)) groups.set(hit.entry, new Set());
        groups.get(hit.entry)!.add(id);
      }

      const writes: Array<{ path: string; dir: string; clean: { pets: unknown[]; [key: string]: unknown } }> = [];
      for (const [entry, groupIds] of groups) {
        let layerPath: string;
        let layerDir: string;
        let existing: Record<string, unknown> | undefined;
        let conf: Record<string, unknown>;
        if (entry === 'main') {
          layerPath = deps.userConfigPath;
          layerDir = deps.userRoot;
          existing = deps.readUser();
          conf = merged.main ?? {};
        } else {
          const file = deps.findPetConfigEntry(entry);
          if (!file) return { kind: 'json', status: 404, obj: { error: `pet config file not found: ${entry}` } };
          layerPath = file.path;
          layerDir = deps.petConfigDir;
          existing = file.raw;
          conf = merged[entry] ?? {};
        }
        const pets = (Array.isArray(conf.pets) ? (conf.pets as Record<string, unknown>[]) : []).map((pet) =>
          groupIds.has(String(pet.id)) ? { ...pet, display: nextDisplay } : pet,
        );
        const clean = saveUserConfig({ pets }, existing);
        if (!clean) return { kind: 'json', status: 400, obj: { error: `invalid pet config: ${entry}` } };
        writes.push({ path: layerPath, dir: layerDir, clean });
      }

      try {
        for (const write of writes) {
          await writeConfig(write.path, write.dir, JSON.stringify(write.clean, null, 2));
        }
      } catch (error) {
        return { kind: 'json', status: 500, obj: { error: errorMessage(error) } };
      }
      if (nextDisplay === 'none') for (const id of ids) deps.releasePetLock?.(id);
      deps.writeConfigChanged();
      deps.reloadDesktop();
      return { kind: 'json', status: 200, obj: deps.readAll() };
    }

    if (rest === 'pet-display') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let payload: { id?: unknown; display?: unknown };
      try {
        payload = JSON.parse(body ?? '') as { id?: unknown; display?: unknown };
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const petId = typeof payload.id === 'string' ? payload.id.trim() : '';
      const nextDisplay = String(payload.display ?? '');
      if (!petId) return { kind: 'json', status: 400, obj: { error: 'missing pet id' } };
      if (!PET_DISPLAY_SET.has(nextDisplay)) {
        return { kind: 'json', status: 400, obj: { error: `invalid display: ${nextDisplay}` } };
      }
      let merged: ConfigRecord;
      try {
        merged = deps.readAll();
      } catch (error) {
        return { kind: 'json', status: 500, obj: { error: errorMessage(error) } };
      }
      const hit = findPetInstance(merged, petId);
      if (!hit) return { kind: 'json', status: 404, obj: { error: `pet not found: ${petId}` } };
      let layerPath: string;
      let layerDir: string;
      let existing: Record<string, unknown> | undefined;
      if (hit.entry === 'main') {
        layerPath = deps.userConfigPath;
        layerDir = deps.userRoot;
        existing = deps.readUser();
      } else {
        const file = deps.findPetConfigEntry(hit.entry);
        if (!file) return { kind: 'json', status: 404, obj: { error: `pet config file not found: ${hit.entry}` } };
        layerPath = file.path;
        layerDir = deps.petConfigDir;
        existing = file.raw;
      }
      const layerPets = Array.isArray(hit.conf.pets) ? (hit.conf.pets as Record<string, unknown>[]) : [];
      const pets = layerPets.map((pet) => (String(pet.id) === petId ? { ...pet, display: nextDisplay } : pet));
      const clean = saveUserConfig({ pets }, existing);
      if (!clean) return { kind: 'json', status: 400, obj: { error: 'invalid pet config' } };
      try {
        await writeConfig(layerPath, layerDir, JSON.stringify(clean, null, 2));
      } catch (error) {
        return { kind: 'json', status: 500, obj: { error: errorMessage(error) } };
      }
      if (nextDisplay === 'none') deps.releasePetLock?.(petId);
      deps.writeConfigChanged();
      deps.reloadDesktop();
      return { kind: 'json', status: 200, obj: deps.readAll() };
    }

    if (rest === 'reload') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      deps.reloadDesktop();
      return { kind: 'json', status: 200, obj: { reloading: true } };
    }
    return undefined;
  };
}

export function createHostConfigRouteDependencies(
  paths: ConfigPaths,
  userRoot: string,
  userConfigPath: string,
  petConfigDir: string,
  writeConfigChanged: () => void,
  reloadDesktop: () => void,
  mapResponseConfig: (config: ConfigRecord) => unknown,
): ConfigRouteDependencies {
  return {
    userRoot,
    userConfigPath,
    petConfigDir,
    findPetConfigEntry: (entry) => readPetConfigEntry(paths, entry),
    readAll: () => readAllConfig(paths),
    readUser: () => readUserConfig(paths),
    userUnparsable: () => userConfigUnparsable(paths),
    syncDefault: () => syncUserConfigFromDefault(paths),
    writeConfig: async (path, directory, content) => {
      await mkdir(directory, { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    writeConfigChanged,
    reloadDesktop,
    mapResponseConfig,
  };
}
