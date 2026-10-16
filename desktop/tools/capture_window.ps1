# Screen-capture the Tauri shell's window as it appears on screen (native viewport and WebView2 composited by the
# desktop), to a PNG. The window must be visible (the shell's --test-window keeps it on top without focus).
param([string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W32 { [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
"@
[W32]::SetProcessDPIAware() | Out-Null
$h = (Get-Process virtual-shot-desktop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
$r = New-Object W32+R; [W32]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Ri - $r.L; $hh = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); "$w x $hh at $($r.L),$($r.T)"
