# Stops the process listening on port 3000 (Vite dev). Messages in English for PS 5 encoding.
$listening = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
if ($listening.Count -eq 0) {
    Write-Host "Port 3000 is free (server already stopped)."
    exit 0
}
$uniqueIds = @($listening | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($processId in $uniqueIds) {
    try {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Write-Host "Stopped process PID $processId (port 3000)."
    } catch {
        Write-Host "Could not stop PID ${processId}: $_"
        exit 1
    }
}
