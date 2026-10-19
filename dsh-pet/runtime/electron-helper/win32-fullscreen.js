'use strict';

/**
 * Read the foreground window bounds inside the existing Electron helper process.
 * This is loaded only when Windows fullscreen hiding is enabled, so the normal
 * display modes do not initialize the FFI binding or create a polling process.
 */
function createForegroundWindowProbe() {
  if (process.platform !== 'win32') {
    throw new Error('Win32 fullscreen detection is only available on Windows.');
  }

  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const Handle = koffi.pointer('DshPetFullscreenHandle', koffi.opaque());
  const Hwnd = koffi.alias('DshPetFullscreenHwnd', Handle);
  const Rect = koffi.struct('DshPetFullscreenRect', {
    left: 'int32_t',
    top: 'int32_t',
    right: 'int32_t',
    bottom: 'int32_t',
  });

  const getForegroundWindow = user32.func('DshPetFullscreenHwnd __stdcall GetForegroundWindow()');
  const getWindowRect = user32.func(
    'int32_t __stdcall GetWindowRect(DshPetFullscreenHwnd hWnd, _Out_ DshPetFullscreenRect *lpRect)',
  );
  const isWindowVisible = user32.func('int32_t __stdcall IsWindowVisible(DshPetFullscreenHwnd hWnd)');
  const isIconic = user32.func('int32_t __stdcall IsIconic(DshPetFullscreenHwnd hWnd)');
  const getClassName = user32.func(
    'int32_t __stdcall GetClassNameA(DshPetFullscreenHwnd hWnd, _Out_ uint8_t *lpClassName, int32_t nMaxCount)',
  );

  return () => {
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
    };
  };
}

module.exports = { createForegroundWindowProbe };
