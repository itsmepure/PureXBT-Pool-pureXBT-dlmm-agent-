Set-Location $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
$p = Start-Process -FilePath $node -ArgumentList 'index.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
Set-Content -Path (Join-Path $PSScriptRoot '.agent-pid') -Value $p.Id
