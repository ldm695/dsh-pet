/** 独立 AI 的单独密钥文件：Windows 使用当前用户 DPAPI，其他平台依赖仅当前用户可读的文件权限。 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

const MAX_BYTES = 16_384;

function protect(action: 'protect' | 'unprotect', value: string): string {
  if (process.platform !== 'win32') return value;
  const transform =
    action === 'protect'
      ? '[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)'
      : '[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($raw); $result=${transform}; [Console]::Out.Write([Convert]::ToBase64String($result))`;
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(value, 'utf8'),
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function restrict(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, lstatSync(path).isDirectory() ? 0o700 : 0o600);
    return;
  }
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  const whoami = join(system, 'System32', 'whoami.exe');
  const identity = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('Cannot identify credential owner');
  execFileSync(join(system, 'System32', 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:F`], {
    stdio: 'pipe',
    windowsHide: true,
  });
}

function safePath(path: string, create: boolean): void {
  const directory = dirname(path);
  if (create && !existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Unsafe credential directory');
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > MAX_BYTES)
      throw new Error('Unsafe credential file');
  }
}

/** 在本机加载密钥；明文只允许短暂存在于当前进程内存。 */
export function loadProtectedApiKey(path: string): string | undefined {
  safePath(path, false);
  if (!existsSync(path)) return undefined;
  restrict(dirname(path));
  restrict(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let stored: string;
  try {
    const opened = fstatSync(fd);
    const pathInfo = lstatSync(path);
    if (opened.dev !== pathInfo.dev || opened.ino === 0 || opened.ino !== pathInfo.ino)
      throw new Error('Credential file changed while opening');
    stored = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  if (Buffer.byteLength(stored, 'utf8') > MAX_BYTES) throw new Error('Credential file too large');
  if (!stored) return undefined;
  return process.platform === 'win32' ? Buffer.from(protect('unprotect', stored), 'base64').toString('utf8') : stored;
}

/** 原子保存或清除密钥；临时文件在写入密文前收紧权限。 */
export function saveProtectedApiKey(path: string, key: string | undefined): void {
  safePath(path, true);
  if (!key) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  const value = process.platform === 'win32' ? protect('protect', Buffer.from(key, 'utf8').toString('base64')) : key;
  if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) throw new Error('Credential file too large');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    restrict(temporary);
    writeFileSync(fd, value, 'utf8');
    closeSync(fd);
    renameSync(temporary, path);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // 写盘失败时，文件描述符可能已经由系统关闭。
    }
    try {
      unlinkSync(temporary);
    } catch {
      // 临时文件可能已被重命名或由系统清理。
    }
    throw error;
  }
}
