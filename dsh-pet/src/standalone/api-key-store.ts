/** Windows DPAPI storage for standalone AI credentials. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

/** 读取当前 Windows 用户可解密的凭据；空文件或无效数据会明确报错。 */
export async function loadProtectedApiKey(path: string): Promise<string | undefined> {
  let encrypted: string;
  try {
    encrypted = (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!encrypted) return undefined;
  const plainBase64 = await dpapi('unprotect', encrypted);
  const key = Buffer.from(plainBase64, 'base64').toString('utf8').trim();
  return key || undefined;
}

/** 原子写入 DPAPI 密文；临时文件与密文均保存在用户数据目录。 */
export async function saveProtectedApiKey(path: string, key: string | undefined): Promise<void> {
  if (!key?.trim()) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return;
  }
  const encrypted = await dpapi('protect', Buffer.from(key.trim(), 'utf8').toString('base64'));
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, encrypted, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

/** Backwards-compatible names for the legacy DeepSeek balance credential. */
export const loadDeepSeekApiKey = loadProtectedApiKey;
export const saveDeepSeekApiKey = saveProtectedApiKey;
