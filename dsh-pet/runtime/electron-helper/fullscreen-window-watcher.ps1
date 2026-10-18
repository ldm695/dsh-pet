$ErrorActionPreference = 'SilentlyContinue'
$source = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public struct DshPetRect { public int Left; public int Top; public int Right; public int Bottom; }
public static class DshPetUser32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out DshPetRect rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
$null = Add-Type -TypeDefinition $source -PassThru
$null = [DshPetUser32]::SetProcessDpiAwarenessContext([IntPtr](-4))
while ($true) {
  $handle = [DshPetUser32]::GetForegroundWindow()
  $rect = New-Object DshPetRect
  if ($handle -ne [IntPtr]::Zero -and [DshPetUser32]::IsWindowVisible($handle) -and -not [DshPetUser32]::IsIconic($handle) -and [DshPetUser32]::GetWindowRect($handle, [ref]$rect)) {
    $className = New-Object System.Text.StringBuilder 128
    $null = [DshPetUser32]::GetClassName($handle, $className, $className.Capacity)
    $sample = '{0},{1},{2},{3},{4}' -f $rect.Left, $rect.Top, $rect.Right, $rect.Bottom, $className.ToString()
  } else {
    $sample = '0,0,0,0,'
  }
  try { [Console]::Out.WriteLine($sample); [Console]::Out.Flush() } catch { break }
  Start-Sleep -Milliseconds 500
}
