# Stop the spike's own shells and browsers: the Tauri exe, plus WebView2 and Chrome processes started with the
# vs-rust-tauri profile (a force-killed shell leaves its WebView2 processes running, still holding the DevTools port).
Get-Process virtual-shot-desktop -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe' or name='chrome.exe'" | Where-Object { $_.CommandLine -like '*vs-rust-tauri*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
