# Total private and working-set memory (MB) of one host: the Tauri exe plus its WebView2 processes, or the spike's Chrome.
param([string]$Which = 'tauri')
$p = if ($Which -like 'tauri*') { @(Get-CimInstance Win32_Process -Filter "name='virtual-shot-desktop.exe'") + @(Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*vs-rust-tauri*' }) }
     else { Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -like '*vs-rust-tauri*' } }
$p = $p | Where-Object { $_ }
"{0} processes, private {1} MB, working set {2} MB" -f $p.Count, [math]::Round(($p | Measure-Object PrivatePageCount -Sum).Sum / 1MB), [math]::Round(($p | Measure-Object WorkingSetSize -Sum).Sum / 1MB)
