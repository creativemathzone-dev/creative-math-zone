param(
  [Parameter(Mandatory = $false)]
  [string]$Destination
)

$ErrorActionPreference = 'Stop'

function Stop-WithMessage([string]$Message) {
  Write-Error $Message
  exit 1
}

if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
  Stop-WithMessage 'Supabase CLI is not installed. Install it first, then run this script again.'
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Stop-WithMessage 'Docker Desktop is required by the Supabase CLI backup command. Install and start Docker Desktop, then run this script again.'
}

$dockerCheck = docker info 2>$null
if ($LASTEXITCODE -ne 0) {
  Stop-WithMessage 'Docker Desktop is installed but not running. Start Docker Desktop, wait until it is ready, then run this script again.'
}

if ([string]::IsNullOrWhiteSpace($Destination)) {
  $Destination = Read-Host 'Enter a private Google Drive for desktop folder path (or another secure folder)'
}
if ([string]::IsNullOrWhiteSpace($Destination)) {
  Stop-WithMessage 'A backup destination folder is required.'
}

$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $resolvedDestination -Force | Out-Null

Write-Host 'Paste the Supabase database connection string. Input is hidden and is not saved by this script.' -ForegroundColor Yellow
$secureConnectionString = Read-Host 'Database connection string' -AsSecureString
$connectionPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureConnectionString)
$remoteDbUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($connectionPtr)

if ($remoteDbUrl -notmatch '^postgres(ql)?://[^:]+:.+@[^/]+/[^?]+') {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($connectionPtr)
  Stop-WithMessage 'That does not look like a PostgreSQL connection string. Copy it from the Supabase Dashboard Connect panel and retry.'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupName = "cmz-supabase-backup-$timestamp"
$workDir = Join-Path ([System.IO.Path]::GetTempPath()) $backupName
$zipPath = Join-Path $resolvedDestination "$backupName.zip"
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

try {
  $commands = @(
    @{ Label = 'Database roles'; Args = @('db','dump',"--remote=$remoteDbUrl",'-f',(Join-Path $workDir 'roles.sql'),'--role-only') },
    @{ Label = 'Database schema'; Args = @('db','dump',"--remote=$remoteDbUrl",'-f',(Join-Path $workDir 'schema.sql')) },
    @{ Label = 'Database records'; Args = @('db','dump',"--remote=$remoteDbUrl",'-f',(Join-Path $workDir 'data.sql'),'--data-only','--use-copy','-x','storage.buckets_vectors','-x','storage.vector_indexes') }
  )

  foreach ($command in $commands) {
    Write-Host "Creating $($command.Label)..."
    $cliArgs = $command.Args
    & supabase @cliArgs
    if ($LASTEXITCODE -ne 0) {
      throw "Supabase CLI failed while creating $($command.Label) (exit code $LASTEXITCODE). No live database changes were made."
    }
  }

  $manifest = @{
    created_at = (Get-Date).ToUniversalTime().ToString('o')
    project_ref = 'krjkkkwxqvvxeifxmgjx'
    contents = @('roles.sql', 'schema.sql', 'data.sql')
    note = 'Logical database dump created with Supabase CLI. Review docs/free-database-backup.md for scope and restore limitations.'
  } | ConvertTo-Json -Depth 3
  Set-Content -LiteralPath (Join-Path $workDir 'manifest.json') -Value $manifest -Encoding utf8

  if (Test-Path -LiteralPath $zipPath) {
    throw "Refusing to overwrite existing backup: $zipPath"
  }
  Compress-Archive -Path (Join-Path $workDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host "Backup created: $zipPath" -ForegroundColor Green
  Write-Host 'Keep this ZIP in a private Drive folder. Do not share it publicly; it contains sensitive centre and student records.' -ForegroundColor Yellow
  Write-Host 'The ZIP is not password-encrypted. Restrict Drive access to trusted centre administrators.' -ForegroundColor Yellow
}
catch {
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Write-Error $_.Exception.Message
  throw
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($connectionPtr)
  $remoteDbUrl = $null
  $secureConnectionString.Dispose()
  if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
}
