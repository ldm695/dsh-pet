/** Windows DPAPI storage for standalone AI credentials. */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const MAX_ENCRYPTED_KEY_BYTES = 16_384;

function dpapi(action: 'protect' | 'unprotect', input: string): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('API Key 的加密保存目前仅支持 Windows；请改用环境变量配置。'));
  }
  const transform =
    action === 'protect'
      ? '$bytes=[Convert]::FromBase64String($input); $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))'
      : '$bytes=[Convert]::FromBase64String($input); $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $raw=[Console]::In.ReadToEnd(); ${transform.replace(/\$input/g, '$raw')}`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Windows DPAPI 操作失败：${Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
    child.stdin.end(input, 'utf8');
  });
}

function assertWindows(): void {
  if (process.platform !== 'win32') {
    throw new Error('API Key 的加密保存目前仅支持 Windows；请改用环境变量配置。');
  }
}

function restrictFile(path: string): void {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const identity = execFileSync(join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('无法确定当前 Windows 用户，密钥文件权限未能安全设置。');
  execFileSync(
    join(systemRoot, 'System32', 'icacls.exe'),
    [path, '/inheritance:r', '/grant:r', `*${sid}:F`],
    { stdio: 'pipe', windowsHide: true },
  );
}

function assertNoBroadGrants(path: string): void {
  const acl = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (/\b(?:Everyone|BUILTIN\\Users|Authenticated Users)\s*:/i.test(acl)
    || /\*S-1-(?:1-0|5-11|5-32-545)\s*:/i.test(acl)) {
    throw new Error('密钥文件权限允许其他用户访问；为避免读取可能暴露的凭据，已拒绝加载。');
  }
}

function assertRegularSingleLinkFile(info: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new Error(`${label}不是安全的普通文件。`);
  }
  if (info.size > MAX_ENCRYPTED_KEY_BYTES) throw new Error(`${label}超过允许的大小。`);
}

async function inspectFile(path: string, label: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  assertRegularSingleLinkFile(info, label);
  return info;
}

async function assertParentDirectory(path: string): Promise<void> {
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('密钥文件所在目录不是安全的普通目录。');
  }
}

function sameFile(left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean {
  // Credential reads need a stable identity even on platforms without O_NOFOLLOW.
  // If this filesystem does not expose a usable inode, refuse to weaken the check.
  return left.dev === right.dev && left.ino !== 0 && right.ino !== 0 && left.ino === right.ino;
}

/** 读取当前 Windows 用户可解密的凭据；空文件或无效数据会明确报错。 */
export async function loadProtectedApiKey(path: string): Promise<string | undefined> {
  const beforeOpen = await inspectFile(path, '密钥文件');
  if (!beforeOpen) return undefined;
  assertWindows();
  await assertParentDirectory(path);
  // Existing DPAPI ciphertext remains usable when it inherits broad permissions from
  // an older data directory: drop inherited grants without rewriting the credential.
  restrictFile(path);
  assertNoBroadGrants(path);

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let encrypted: string;
  try {
    const opened = await handle.stat();
    assertRegularSingleLinkFile(opened, '密钥文件');
    const afterOpen = await lstat(path);
    assertRegularSingleLinkFile(afterOpen, '密钥文件');
    if (!sameFile(beforeOpen, opened) || !sameFile(opened, afterOpen)) {
      throw new Error('密钥文件在读取期间发生变化，已拒绝加载。');
    }

    // Read at most the configured limit plus one byte, so a concurrent replacement or
    // file growth cannot make this read allocate an unbounded buffer.
    const buffer = Buffer.alloc(MAX_ENCRYPTED_KEY_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const finalStat = await handle.stat();
    assertRegularSingleLinkFile(finalStat, '密钥文件');
    if (bytesRead > MAX_ENCRYPTED_KEY_BYTES || bytesRead !== finalStat.size) {
      throw new Error('密钥文件在读取期间发生变化或超过允许的大小。');
    }
    encrypted = buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await handle.close();
  }

  if (!encrypted) return undefined;
  const plainBase64 = await dpapi('unprotect', encrypted);
  const key = Buffer.from(plainBase64, 'base64').toString('utf8').trim();
  return key || undefined;
}

/** 原子写入 DPAPI 密文；临时文件与密文均保存在用户数据目录。 */
export async function saveProtectedApiKey(path: string, key: string | undefined): Promise<void> {
  if (!key?.trim()) {
    const existing = await inspectFile(path, '密钥文件');
    if (!existing) return;
    await assertParentDirectory(path);
    await unlink(path);
    return;
  }

  const encrypted = await dpapi('protect', Buffer.from(key.trim(), 'utf8').toString('base64'));
  if (Buffer.byteLength(encrypted, 'utf8') > MAX_ENCRYPTED_KEY_BYTES) {
    throw new Error('加密后的密钥超过允许的大小。');
  }
  const directoryPath = dirname(path);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await assertParentDirectory(path);

  await inspectFile(path, '密钥文件');

  const temporary = join(directoryPath, `${process.pid}-${randomUUID()}.api-key.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    // Lock down the ACL before any ciphertext reaches disk.
    restrictFile(temporary);
    await handle.writeFile(encrypted, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Re-check the destination just before replacement. rename replaces the directory
    // entry itself, so it cannot write through a destination symlink or hard link.
    await inspectFile(path, '密钥文件');
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
