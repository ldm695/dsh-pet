'use strict';

/**
 * Read foreground-window and Lossless Scaling output-window state inside the existing Electron helper process.
 * This is loaded only when Windows fullscreen or maximized-window hiding is enabled, so the normal
 * display modes do not initialize the FFI binding or create a polling process.
 */
function createFullscreenWindowProbe() {
  if (process.platform !== 'win32') {
    throw new Error('Win32 fullscreen detection is only available on Windows.');
  }

  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const Handle = koffi.pointer('DshPetFullscreenHandle', koffi.opaque());
  const Hwnd = koffi.alias('DshPetFullscreenHwnd', Handle);
  const Rect = koffi.struct('DshPetFullscreenRect', {
    left: 'int32_t',
    top: 'int32_t',
    right: 'int32_t',
    bottom: 'int32_t',
  });
  const EnumWindowsProc = koffi.proto(
    'int32_t __stdcall DshPetFullscreenEnumWindowsProc(DshPetFullscreenHwnd hWnd, void *lParam)',
  );

  const getForegroundWindow = user32.func('DshPetFullscreenHwnd __stdcall GetForegroundWindow()');
  const getWindowRect = user32.func(
    'int32_t __stdcall GetWindowRect(DshPetFullscreenHwnd hWnd, _Out_ DshPetFullscreenRect *lpRect)',
  );
  const isWindowVisible = user32.func('int32_t __stdcall IsWindowVisible(DshPetFullscreenHwnd hWnd)');
  const isIconic = user32.func('int32_t __stdcall IsIconic(DshPetFullscreenHwnd hWnd)');
  const isZoomed = user32.func('int32_t __stdcall IsZoomed(DshPetFullscreenHwnd hWnd)');
  const enumWindows = user32.func('__stdcall', 'EnumWindows', 'int32_t', [koffi.pointer(EnumWindowsProc), 'void *']);
  const getClassName = user32.func(
    'int32_t __stdcall GetClassNameA(DshPetFullscreenHwnd hWnd, _Out_ uint8_t *lpClassName, int32_t nMaxCount)',
  );
  const getClassNameWide = user32.func(
    'int32_t __stdcall GetClassNameW(DshPetFullscreenHwnd hWnd, _Out_ uint16_t *lpClassName, int32_t nMaxCount)',
  );
  const getWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(DshPetFullscreenHwnd hWnd, _Out_ uint32_t *lpdwProcessId)',
  );
  const openProcess = kernel32.func(
    'DshPetFullscreenHandle __stdcall OpenProcess(uint32_t dwDesiredAccess, int32_t bInheritHandle, uint32_t dwProcessId)',
  );
  const queryFullProcessImageName = kernel32.func(
    'int32_t __stdcall QueryFullProcessImageNameW(DshPetFullscreenHandle hProcess, uint32_t dwFlags, _Out_ uint16_t *lpExeName, _Inout_ uint32_t *lpdwSize)',
  );
  const closeHandle = kernel32.func('int32_t __stdcall CloseHandle(DshPetFullscreenHandle hObject)');
  const desktopShellClasses = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);

  function readClassName(hWnd) {
    const buffer = Buffer.alloc(512);
    const length = getClassNameWide(hWnd, buffer, buffer.length / 2);
    return length > 0 ? buffer.toString('utf16le', 0, length * 2) : '';
  }

  function readProcessName(processId, processNameCache) {
    if (!processId) return '';
    const cached = processNameCache.get(processId);
    if (cached) return cached;

    const processHandle = openProcess(0x1000, 0, processId);
    if (!processHandle) return '';
    try {
      const buffer = Buffer.alloc(2048);
      const length = Buffer.alloc(4);
      length.writeUInt32LE(buffer.length / 2);
      if (!queryFullProcessImageName(processHandle, 0, buffer, length)) return '';
      const charsWritten = length.readUInt32LE(0);
      const imagePath = buffer.toString('utf16le', 0, charsWritten * 2);
      const separator = Math.max(imagePath.lastIndexOf('\\'), imagePath.lastIndexOf('/'));
      const processName = imagePath.slice(separator + 1).replace(/\.exe$/i, '');
      if (processName) {
        if (processNameCache.size >= 128) processNameCache.clear();
        processNameCache.set(processId, processName);
      }
      return processName;
    } finally {
      try {
        closeHandle(processHandle);
      } catch {}
    }
  }

  function enumerateLosslessScalingWindows(displayBounds = []) {
    const windows = [];
    const processNameCache = new Map();
    const matchesDisplayBounds = (rect, bounds) => {
      const tolerance = Math.max(10, Math.round(Math.min(bounds.width, bounds.height) * 0.02));
      return (
        Math.abs(rect.left - bounds.x) <= tolerance &&
        Math.abs(rect.top - bounds.y) <= tolerance &&
        Math.abs(rect.right - (bounds.x + bounds.width)) <= tolerance &&
        Math.abs(rect.bottom - (bounds.y + bounds.height)) <= tolerance
      );
    };
    const callback = (hWnd) => {
      try {
        if (!hWnd || !isWindowVisible(hWnd) || isIconic(hWnd)) return 1;
        const rect = {};
        if (!getWindowRect(hWnd, rect)) return 1;
        if (!displayBounds.some((bounds) => matchesDisplayBounds(rect, bounds))) return 1;

        const className = readClassName(hWnd);
        if (desktopShellClasses.has(className)) return 1;
        let processName = '';
        const matchesClass = className.toLowerCase().includes('losslessscaling');
        if (!matchesClass) {
          const processIdBuffer = Buffer.alloc(4);
          getWindowThreadProcessId(hWnd, processIdBuffer);
          processName = readProcessName(processIdBuffer.readUInt32LE(0), processNameCache);
        }
        if (matchesClass || processName.toLowerCase().includes('losslessscaling')) {
          windows.push({
            className,
            processName,
            rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          });
        }
      } catch {
        // A transient window or an inaccessible process must not affect other windows.
      }
      return 1;
    };

    if (!enumWindows(callback, null)) throw new Error('EnumWindows failed while checking Lossless Scaling windows.');
    return windows;
  }

  function readForegroundWindow() {
    const hWnd = getForegroundWindow();
    if (!hWnd || !isWindowVisible(hWnd) || isIconic(hWnd)) return null;

    const rect = {};
    if (!getWindowRect(hWnd, rect)) return null;

    const classNameBuffer = Buffer.alloc(128);
    const classNameLength = getClassName(hWnd, classNameBuffer, classNameBuffer.length);
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      className: classNameLength > 0 ? classNameBuffer.toString('ascii', 0, classNameLength) : '',
      isMaximized: Boolean(isZoomed(hWnd)),
    };
  }

  return { readForegroundWindow, enumerateLosslessScalingWindows };
}

module.exports = { createFullscreenWindowProbe };
