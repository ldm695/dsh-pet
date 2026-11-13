/**
 * 独立模式迁移备份的本机路由。
 *
 * 将恢复操作从启动器拆出，供当前版本的设置页使用；读取只暴露备份摘要，写操作仍受本机令牌保护。
 * @module dsh-pet/src/standalone/migration-recovery-routes
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';

import { ROUTE_SEGMENT } from '../shared/constants.ts';
import { getMigrationRecovery, restoreMigrationConfiguration } from './migrations.ts';
import type { RegisteredRoute } from './context.ts';

interface MigrationRecoveryRouteOptions {
  home: string;
  openBackupFolder(path: string): Promise<void>;
  shutdown(reason: string): void;
}

/** 在本机文件管理器中打开已验证的备份目录。 */
export function openMigrationBackupFolder(path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [path], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 创建设置页使用的异常迁移备份路由。 */
export function createMigrationRecoveryRoutes(options: MigrationRecoveryRouteOptions): RegisteredRoute[] {
  const path = `${ROUTE_SEGMENT}/migration-recovery`;
  return [
    {
      kind: 'exact',
      path,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        const recovery = getMigrationRecovery(options.home);
        sendJson(res, 200, recovery ? { available: true, ...recovery } : { available: false });
      },
    },
    {
      kind: 'exact',
      path: `${path}/open`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          const recovery = getMigrationRecovery(options.home);
          if (!recovery) throw new Error('没有可打开的迁移异常备份。');
          await options.openBackupFolder(join(recovery.backupDirectory, 'dsh-pet'));
          sendJson(res, 200, { ok: true });
        } catch (error) {
          sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${path}/restore`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          await restoreMigrationConfiguration(options.home);
          sendJson(res, 200, { ok: true, stopping: true });
          setTimeout(() => options.shutdown('迁移配置还原'), 150).unref();
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  ];
}
