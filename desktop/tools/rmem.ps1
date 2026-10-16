# Private memory (MB) of the spike's renderer processes right now (WebView2 or Chrome started with the vs-rust-tauri profile)
Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe' or name='chrome.exe'" | Where-Object { $_.CommandLine -like '*vs-rust-tauri*' -and $_.CommandLine -match '--type=renderer' } |
  ForEach-Object { "$($_.Name) $($_.ProcessId) $([math]::Round($_.PrivatePageCount/1MB)) MB" }
