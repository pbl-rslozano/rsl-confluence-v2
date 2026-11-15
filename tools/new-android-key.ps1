<#
  new-android-key.ps1 - rsL Confluence Terminal by rsLozano

  Makes a NEW Android release signing key on this PC and saves it as the four GitHub repository
  secrets the release workflow reads:
      ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
  It also adds NETLIFY_AUTH_TOKEN (the update-channel publisher token) if that secret is missing.

  The key file stays on this PC. The key and the password you choose go only to GitHub, which stores
  them encrypted. The script never prints them; it shows only the certificate fingerprint (public).

  Run it in PowerShell from the folder that holds it:
      powershell -ExecutionPolicy Bypass -File .\new-android-key.ps1

  Runbook: docs/runbooks/rotate-a-key.md
#>
[CmdletBinding()]
param(
  [string]$Repo = "pbl-rslozano/rsl-confluence-v2",
  [string]$OutDir = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "rsL-signing"),
  [string]$Alias = "rsl-conf"
)
$ErrorActionPreference = "Stop"

function Say([string]$Text, [string]$Color = "Gray") { Write-Host $Text -ForegroundColor $Color }
function Step([string]$N, [string]$Text) { Write-Host ""; Write-Host "[$N] $Text" -ForegroundColor Cyan }
function Ask-YesNo([string]$Question) { (Read-Host "$Question [Y/N]") -match '^(y|yes)$' }

function Unprotect([Security.SecureString]$Secure) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Find-Keytool {
  $cmd = Get-Command keytool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Path }
  $candidates = @()
  if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME "bin\keytool.exe") }
  $candidates += @(
    (Join-Path $env:ProgramFiles "Android\Android Studio\jbr\bin\keytool.exe"),
    (Join-Path $env:ProgramFiles "Android\Android Studio\jre\bin\keytool.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Android Studio\jbr\bin\keytool.exe")
  )
  foreach ($vendor in @("Microsoft", "Eclipse Adoptium", "Java", "Zulu", "Amazon Corretto", "BellSoft")) {
    $root = Join-Path $env:ProgramFiles $vendor
    if (Test-Path $root) {
      $candidates += (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName "bin\keytool.exe" })
    }
  }
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

function Find-Gh {
  $cmd = Get-Command gh.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Path }
  foreach ($p in @((Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"), (Join-Path $env:LOCALAPPDATA "Programs\GitHub CLI\gh.exe"))) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

# Saves one secret with the GitHub CLI. The value goes through standard input, never the command line.
function Set-RepoSecret([string]$Name, [string]$Value) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:Gh
  $psi.Arguments = "secret set $Name --repo $Repo"
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $proc.StandardInput.Write($Value)
  $proc.StandardInput.Close()
  $null = $proc.StandardOutput.ReadToEnd()
  $err = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { throw "GitHub did not accept $Name. $err" }
  Say "    saved $Name" Green
}

# Without the GitHub CLI: put one value on the clipboard and wait while the person pastes it on GitHub.
function Paste-RepoSecret([string]$Name, [string]$Value, [string]$Hint) {
  if ($Value) { Set-Clipboard -Value $Value }
  Say ""
  Say "    Secret name:  $Name" White
  Say "    $Hint" White
  Say "    On the GitHub page: click $Name > Update secret (or New repository secret if it is not listed)," Gray
  Say "    paste with Ctrl+V, then click Update secret / Add secret." Gray
  $null = Read-Host "    Press Enter when it is saved"
}

function Clear-ClipboardText { cmd.exe /c "echo off | clip" | Out-Null }

# Runs a native command quietly and returns $true when it succeeds. Windows PowerShell 5.1 turns a native
# command's redirected error output into terminating errors under "Stop", so this relaxes it for the call.
function Test-Native([scriptblock]$Block) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $Block *> $null; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $old }
}

Say ""
Say "rsL Confluence Terminal - new Android signing key" White
Say "Repository: $Repo" Gray
Say "Phones that have v2.6 installed will need to uninstall it once and install v2.7 fresh." Yellow
Say "(Export a backup from About and the ledger from the Ledger first.)" Yellow
if (-not (Ask-YesNo "Make a new key now?")) { Say "Nothing was changed."; exit 0 }

# ---------------------------------------------------------------------------------------------------
Step "1/5" "Checking the tools"
$keytool = Find-Keytool
if (-not $keytool) {
  Say "    Java's keytool was not found (it comes with Java or Android Studio)." Yellow
  if (Ask-YesNo "    Install Microsoft OpenJDK 21 with winget now?") {
    winget install --id Microsoft.OpenJDK.21 -e --accept-source-agreements --accept-package-agreements
    $keytool = Find-Keytool
  }
  if (-not $keytool) { throw "keytool is still missing. Install Java (for example Microsoft OpenJDK 21) and run this script again." }
}
Say "    keytool: $keytool" Green

$script:Gh = Find-Gh
if (-not $script:Gh) {
  Say "    The GitHub CLI (gh) was not found. With it, this script saves the secrets for you." Yellow
  if (Ask-YesNo "    Install the GitHub CLI with winget now?") {
    winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
    $script:Gh = Find-Gh
  }
}
$manual = $true
if ($script:Gh) {
  if (-not (Test-Native { & $script:Gh auth status --hostname github.com })) {
    Say "    Sign in to GitHub in the browser window that opens (account that owns $Repo)." Yellow
    & $script:Gh auth login --hostname github.com --web --git-protocol https
  }
  if (Test-Native { & $script:Gh repo view $Repo --json name }) { $manual = $false; Say "    GitHub CLI signed in; secrets will be saved automatically." Green }
  else { Say "    The GitHub CLI cannot open $Repo with this account; you will paste the secrets by hand." Yellow }
} else {
  Say "    You will paste the secrets on the GitHub page by hand (the script puts each one on the clipboard)." Yellow
}

# ---------------------------------------------------------------------------------------------------
Step "2/5" "Choose the key password"
Say "    12 or more characters: letters, digits and symbols (no spaces, English keyboard characters only)." Gray
Say "    Save it in your password manager. Without it the key cannot be used again." Gray
while ($true) {
  $first = Unprotect (Read-Host "    Password" -AsSecureString)
  $second = Unprotect (Read-Host "    Type it again" -AsSecureString)
  if ($first -cne $second) { Say "    The two entries differ. Try again." Yellow; continue }
  if ($first -cnotmatch '^[\x21-\x7E]{12,}$') { Say "    Use 12 or more letters, digits or symbols, without spaces." Yellow; continue }
  break
}
$password = $first
$first = $null; $second = $null

# ---------------------------------------------------------------------------------------------------
Step "3/5" "Making the key"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$keystore = Join-Path $OutDir "rsl-confluence-android-$stamp.keystore"
if (Test-Path $keystore) { throw "$keystore already exists; nothing was overwritten." }
$env:RSL_NEW_KEY_PW = $password
$oldPref = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try {
  & $keytool -genkeypair -keystore $keystore -storetype PKCS12 -alias $Alias -keyalg RSA -keysize 4096 -validity 10000 `
    -dname "CN=rsLozano, OU=rsL Confluence Terminal, O=rsL" -storepass:env RSL_NEW_KEY_PW -keypass:env RSL_NEW_KEY_PW -noprompt
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $keystore)) { throw "keytool could not make the key." }
  $listing = & $keytool -list -v -keystore $keystore -storetype PKCS12 -alias $Alias -storepass:env RSL_NEW_KEY_PW
  if ($LASTEXITCODE -ne 0) { throw "The new key could not be opened with the password." }
} finally {
  Remove-Item Env:\RSL_NEW_KEY_PW -ErrorAction SilentlyContinue
  $ErrorActionPreference = $oldPref
}
$fpLine = $listing | Select-String -Pattern 'SHA256:\s*([0-9A-F:]+)' | Select-Object -First 1
$fingerprint = if ($fpLine) { $fpLine.Matches[0].Groups[1].Value } else { "(not read)" }
$bytes = [IO.File]::ReadAllBytes($keystore)
$b64 = [Convert]::ToBase64String($bytes)
if ([Convert]::FromBase64String($b64).Length -ne $bytes.Length) { throw "Encoding check failed." }
Say "    Key file: $keystore" Green
Say "    Certificate SHA-256: $fingerprint" Green

$info = @(
  "rsL Confluence Terminal - Android release signing key",
  "Made:            $(Get-Date -Format 'yyyy-MM-dd HH:mm') on $env:COMPUTERNAME",
  "Key file:        $(Split-Path $keystore -Leaf)  (PKCS12)",
  "Alias:           $Alias",
  "Certificate SHA-256: $fingerprint",
  "GitHub secrets:  ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD ($Repo)",
  "Password:        in your password manager (not in this file). The key password equals the keystore password.",
  "Keep a second copy of the key file offline (USB drive). Every future Android update must be signed with it."
)
Set-Content -Path (Join-Path $OutDir "rsl-confluence-android-$stamp.txt") -Value $info -Encoding ASCII

# ---------------------------------------------------------------------------------------------------
Step "4/5" "Saving the GitHub secrets"
if (-not $manual) {
  Set-RepoSecret "ANDROID_KEYSTORE_B64" $b64
  Set-RepoSecret "ANDROID_KEYSTORE_PASSWORD" $password
  Set-RepoSecret "ANDROID_KEY_ALIAS" $Alias
  Set-RepoSecret "ANDROID_KEY_PASSWORD" $password
  $ErrorActionPreference = "Continue"
  $names = (& $script:Gh secret list --repo $Repo 2>$null) | ForEach-Object { ($_ -split '\s+')[0] }
  $ErrorActionPreference = "Stop"
  if ($names -notcontains "NETLIFY_AUTH_TOKEN") {
    Say "    NETLIFY_AUTH_TOKEN is missing; the website update needs it." Yellow
    Say "    Make one at https://app.netlify.com/user/applications#personal-access-tokens (New access token)." Gray
    $token = Unprotect (Read-Host "    Paste the Netlify token (or press Enter to skip)" -AsSecureString)
    if ($token) { Set-RepoSecret "NETLIFY_AUTH_TOKEN" $token.Trim() } else { Say "    Skipped NETLIFY_AUTH_TOKEN." Yellow }
    $token = $null
  } else {
    Say "    NETLIFY_AUTH_TOKEN is already set." Green
  }
} else {
  Start-Process "https://github.com/$Repo/settings/secrets/actions"
  Paste-RepoSecret "ANDROID_KEYSTORE_B64" $b64 "The encoded key is on the clipboard (one long line)."
  Clear-ClipboardText
  Paste-RepoSecret "ANDROID_KEYSTORE_PASSWORD" "" "Type the password you just chose."
  Paste-RepoSecret "ANDROID_KEY_ALIAS" $Alias "The value is on the clipboard: $Alias"
  Paste-RepoSecret "ANDROID_KEY_PASSWORD" "" "Type the same password again."
  Say "    Also check that NETLIFY_AUTH_TOKEN is listed on that page (a Netlify personal access token)." Yellow
  Clear-ClipboardText
}
$password = $null; $b64 = $null; $bytes = $null
[GC]::Collect()

# ---------------------------------------------------------------------------------------------------
Step "5/5" "Done"
Say "    Copy $OutDir to a USB drive or another safe place now, and keep the password in your password manager." Yellow
Say "    Then tell Claude: key updated" White
Say ""
