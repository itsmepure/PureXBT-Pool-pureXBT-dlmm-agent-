# Step 2: Clean secrets in example config + finish git prep
$ErrorActionPreference = "Stop"
$PushDir = "D:\Garapan\sol farm agent\deploy\github-push"
Set-Location $PushDir

Write-Host "[Step A] Cleaning secrets from user-config.example.json..."
$cfg = Get-Content "user-config.example.json" -Raw
# Clear sensitive fields
$cfg = $cfg -replace '("llmApiKey"\s*:\s*)"[^"]*"', '$1""'
$cfg = $cfg -replace '("llmBaseUrl"\s*:\s*)"[^"]*"', '$1""'
$cfg = $cfg -replace '("publicApiKey"\s*:\s*)"[^"]*"', '$1""'
$cfg = $cfg -replace '("hiveMindApiKey"\s*:\s*)"[^"]*"', '$1""'
$cfg = $cfg -replace '("telegramChatId"\s*:\s*)"[^"]*"', '$1""'
$cfg = $cfg -replace '("agentId"\s*:\s*)"[^"]*"', '$1""'
# Ensure agentPureXbtApiUrl stays as example URL
$cfg = $cfg -replace '("agentPureXbtApiUrl"\s*:\s*)"[^"]*"', '$1"https://api.agentmeridian.xyz"'
$cfg | Set-Content "user-config.example.json" -NoNewline
Write-Host "  Secrets cleared"

# Check .gitignore has all patterns
Write-Host "[Step B] Verifying .gitignore..."
$required = @(
    "node_modules/", ".env", ".env.*", "!.env.example", ".envrypt",
    "user-config.json", "state.json", "lessons.json", "smart-wallets.json",
    "pool-memory.json", "token-blacklist.json", "strategy-library.json",
    "decision-log.json", "hivemind-cache.json", "signal-weights.json",
    "wallets.json", "chat-history.json", "dev-blocklist.json",
    "deployer-blacklist.json", "discord-signals.json", "logs/",
    ".playwright-mcp/", ".claude/scheduled_tasks.lock"
)
$existing = Get-Content .gitignore -ErrorAction SilentlyContinue
$newPatterns = $required | Where-Object { $_ -notin $existing }
if ($newPatterns) {
    $newPatterns | Add-Content .gitignore
    Write-Host "  Added $($newPatterns.Count) new gitignore patterns"
} else {
    Write-Host "  .gitignore already complete"
}

# Git init + stage
Write-Host "[Step C] Git setup..."
if (!(Test-Path ".git")) {
    git init
}

# Check/set remote - silently check if origin exists
$hasRemote = git rev-parse --git-dir 2>$null
if ($hasRemote) {
    $remotes = git remote 2>$null
    if ($remotes -notcontains "origin") {
        git remote add origin https://github.com/itsmepure/PureXBT-Pool-pureXBT-dlmm-agent-.git
        Write-Host "  Remote set to: itsmepure/PureXBT-Pool-pureXBT-dlmm-agent-"
    }
} else {
    git remote add origin https://github.com/itsmepure/PureXBT-Pool-pureXBT-dlmm-agent-.git
    Write-Host "  Remote set to: itsmepure/PureXBT-Pool-pureXBT-dlmm-agent-"
}

git add .
Write-Host ""
Write-Host "=== Staged files ===" -ForegroundColor Cyan
git diff --cached --stat
Write-Host ""
Write-Host "Ready to commit! Run:" -ForegroundColor Green
Write-Host "git commit -m 'feat: PureXBT Pool Agent - per-wallet config, position history, LLM optimizations, parallel bottlenecks'"
