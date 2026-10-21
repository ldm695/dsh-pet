import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { chmod, lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_CONFIG_BYTES = 32_768;

/** Never pass a shell command, account name, or an unvalidated SID to icacls. */
function restrictFile(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
    return;
  }
  const identity = execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true },
  );
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('Cannot identify file owner');
  execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    [path, '/inheritance:r', '/grant:r', `*${sid}:F`],
    { stdio: 'pipe', windowsHide: true },
  );
}

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${file} failed: ${Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function restrictFileAsync(path: string): Promise<void> {
  if (process.platform !== 'win32') {
    await chmod(path, 0o600);
    return;
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const identity = await runFile(join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('Cannot identify file owner');
  await runFile(join(systemRoot, 'System32', 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:F`]);
}

function configPath(home: string): string {
  const directory = join(home, 'dsh-pet');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe settings directory');
  return join(directory, 'standalone-ai.json');
}

export function readAiSettings(home: string): unknown | undefined {
  const path = configPath(home);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error('Unsafe settings file');
  // Refuse broad explicit Windows grants rather than reading a potentially public secret.
  // Files created here have no explicit grants except the current SID.
  if (process.platform === 'win32') {
    const acl = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (/\b(?:Everyone|BUILTIN\\Users|Authenticated Users)\s*:/i.test(acl))
      throw new Error('Unsafe settings permissions');
  }
  restrictFile(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (fstatSync(fd).size > MAX_CONFIG_BYTES) throw new Error('Settings file too large');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

/** Set permissions on an empty exclusive temporary file BEFORE writing any secret. */
export function writeAiSettings(home: string, settings: unknown): void {
  // API keys are DPAPI-protected in a separate file; never persist plaintext here.
  const value = settings && typeof settings === 'object' ? { ...(settings as Record<string, unknown>) } : {};
  delete value.apiKey;
  writePrivateJson(configPath(home), value);
}

/** Internal server utility; caller supplies an existing, trusted parent directory. */
export function writePrivateJson(path: string, settings: unknown): void {
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe private file directory');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error('Unsafe settings file');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    restrictFile(temporary);
    writeFileSync(fd, JSON.stringify(settings), { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

/** Atomically write a private file without blocking the event loop while bytes reach disk. */
export async function writePrivateTextAsync(path: string, contents: string): Promise<void> {
  const directoryPath = dirname(path);
  const directory = await lstat(directoryPath);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe private file directory');

  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) {
      throw new Error('Unsafe settings file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporary = join(directoryPath, `${process.pid}-${randomUUID()}.private-json.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    // Lock down inherited Windows ACLs before writing any chat history to the file.
    await restrictFileAsync(temporary);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    // Recheck immediately before replacement; rename replaces the directory entry, not a link target.
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink > 1) {
        throw new Error('Unsafe settings file');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Atomically write a private JSON file without blocking the event loop while bytes reach disk. */
export async function writePrivateJsonAsync(
  path: string,
  settings: unknown,
  space?: string | number,
): Promise<void> {
  const serialized = JSON.stringify(settings, null, space);
  if (serialized === undefined) throw new Error('Value is not serializable as JSON');
  await writePrivateTextAsync(path, serialized);
}
