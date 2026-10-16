# Sample the private memory of the spike's browser renderer processes (WebView2 or Chrome launched with the
# vs-rust-tauri profile) once a second; one CSV line per process per sample.
#   powershell -File desktop/tools/procmem.ps1 <out.csv> [seconds=900]
param([string]$Out, [int]$Seconds = 900)
"time,pid,exe,type,private_mb,working_set_mb" | Out-File -Encoding utf8 $Out
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  $t = (Get-Date).ToString('HH:mm:ss')
  Get-CimInstance Win32_Process -Filter "name='msedgewebview2.exe' or name='chrome.exe'" | Where-Object { $_.CommandLine -like '*vs-rust-tauri*' } | ForEach-Object {
    $type = if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'browser' }
    if ($type -eq 'renderer' -or $type -eq 'gpu-process' -or $type -eq 'browser') {
      "$t,$($_.ProcessId),$($_.Name),$type,$([math]::Round($_.PrivatePageCount/1MB)),$([math]::Round($_.WorkingSetSize/1MB))" | Out-File -Append -Encoding utf8 $Out
    }
  }
  Start-Sleep -Seconds 1
}
