$root = Split-Path -Parent $PSScriptRoot

function Test-ListeningPort($port) {
    return [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (Test-ListeningPort 3000) {
    Write-Host 'Backend already running on http://localhost:3000'
} else {
    Start-Process powershell.exe -WorkingDirectory $root -ArgumentList @(
        '-NoExit',
        '-Command',
        'npm --prefix backend run dev'
    )
}

if (Test-ListeningPort 5173) {
    Write-Host 'Frontend already running on http://localhost:5173'
} else {
    Start-Process powershell.exe -WorkingDirectory $root -ArgumentList @(
        '-NoExit',
        '-Command',
        'npm --prefix frontend run dev'
    )
}

Write-Host 'Development services are ready.'
Write-Host 'Backend: http://localhost:3000'
Write-Host 'Frontend: http://localhost:5173'
