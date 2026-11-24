# Builds the CyberPad desktop app and packages it as dist/CyberPad-win-x64-<version>.zip.
# Works in Windows PowerShell 5.1. Stops at the first failing step.
#   powershell -ExecutionPolicy Bypass -File desktop/build.ps1

$ErrorActionPreference = 'Stop'

$desktop = $PSScriptRoot
$root = Split-Path -Parent $desktop
$sln = Join-Path $desktop 'CyberPad.sln'
$project = Join-Path $desktop 'CyberPad.Desktop'
$csproj = Join-Path $project 'CyberPad.Desktop.csproj'
$dist = Join-Path $root 'dist'
$publishDir = Join-Path $dist 'CyberPad'

function Assert-ExitCode([string]$step) {
    # Native commands do not trip $ErrorActionPreference in PowerShell 5.1.
    if ($LASTEXITCODE -ne 0) {
        throw "$step failed (exit code $LASTEXITCODE)."
    }
}

# Read before anything is built, so a bad version fails fast instead of after the publish.
[xml]$xml = Get-Content -LiteralPath $csproj -Raw
$version = $null
foreach ($group in @($xml.Project.PropertyGroup)) {
    if ($group.Version) { $version = [string]$group.Version; break }
}
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw 'Could not read a valid <Version> from the .csproj.'
}

Push-Location $root
try {
    Write-Host '== 1/5 npm test'
    & npm test
    Assert-ExitCode 'npm test'

    Write-Host '== 2/5 dotnet test'
    & dotnet test $sln -c Release
    Assert-ExitCode 'dotnet test'

    Write-Host '== 3/5 vulnerable package audit'
    # The CLI text is localized, so audit through the JSON output instead.
    $auditText = (& dotnet list $sln package --vulnerable --include-transitive --format json) -join "`n"
    Assert-ExitCode 'dotnet list package --vulnerable'
    try {
        $audit = $auditText | ConvertFrom-Json
    } catch {
        throw 'Vulnerability audit output could not be parsed.'
    }
    if ($null -eq $audit -or $null -eq $audit.projects) {
        throw 'Vulnerability audit output has no projects section.'
    }
    # An audit that could not reach the feed (or otherwise reported problems) must not pass.
    $problemList = New-Object System.Collections.Generic.List[string]
    $allProblems = @($audit.problems)
    foreach ($p in @($audit.projects)) { $allProblems += @($p.problems) }
    foreach ($pr in $allProblems) {
        if ($null -eq $pr) { continue }
        $level = ([string]$pr.level).ToLowerInvariant()
        if ($level -eq 'error' -or $level -eq 'warning') {
            $problemList.Add("$($pr.level) $($pr.code) $($pr.text)".Trim())
        }
    }
    if ($problemList.Count -gt 0) {
        throw ("Vulnerability audit reported problems:`n" + ($problemList -join "`n"))
    }
    $vulnerable = New-Object System.Collections.Generic.List[string]
    foreach ($p in @($audit.projects)) {
        foreach ($f in @($p.frameworks)) {
            if ($null -eq $f) { continue }
            foreach ($pkg in @($f.topLevelPackages) + @($f.transitivePackages)) {
                if ($null -ne $pkg) {
                    $vulnerable.Add("$($pkg.id) $($pkg.resolvedVersion) in $($p.path)")
                }
            }
        }
    }
    if ($vulnerable.Count -gt 0) {
        throw ("Vulnerable packages found:`n" + ($vulnerable -join "`n"))
    }
    Write-Host 'No vulnerable packages.'

    Write-Host '== 4/5 dotnet publish'
    if (Test-Path -LiteralPath $publishDir) {
        Remove-Item -LiteralPath $publishDir -Recurse -Force
    }
    # No .pdb (its embedded path names the build machine's user folder) and no package XML docs in the release.
    & dotnet publish $project -c Release -r win-x64 --self-contained true `
        -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:DebugType=none -p:GenerateDocumentationFile=false -p:PublishReferencesDocumentationFiles=false `
        -o $publishDir
    Assert-ExitCode 'dotnet publish'

    Write-Host '== 5/5 zip'
    foreach ($required in @('CyberPad.exe', 'wwwroot\index.html')) {
        if (-not (Test-Path -LiteralPath (Join-Path $publishDir $required) -PathType Leaf)) {
            throw "Publish output is missing $required."
        }
    }
    $leftovers = @(Get-ChildItem -LiteralPath $publishDir -Recurse -File | Where-Object { $_.Extension -eq '.pdb' -or $_.Extension -eq '.xml' })
    if ($leftovers.Count -gt 0) {
        throw ("Publish output contains debug or documentation files:`n" + (($leftovers | ForEach-Object { $_.Name }) -join "`n"))
    }
    $zip = Join-Path $dist "CyberPad-win-x64-$version.zip"
    # ZipFile reads each file with FileShare.Read, so an indexer or antivirus scanner that has a file open for
    # reading does not block it (Compress-Archive in PowerShell 5.1 opens files exclusively and fails then).
    # A writer can still hold a file briefly, so retry a few times.
    # Zip entry names must use '/' (Windows PowerShell's .NET Framework writes '\' unless told otherwise).
    [AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipped = $false
    for ($attempt = 1; $attempt -le 5 -and -not $zipped; $attempt++) {
        if (Test-Path -LiteralPath $zip) {
            Remove-Item -LiteralPath $zip -Force
        }
        try {
            [System.IO.Compression.ZipFile]::CreateFromDirectory($publishDir, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
            $zipped = $true
        } catch {
            if ($attempt -eq 5) { throw }
            Write-Host "Zip attempt $attempt failed, retrying: $($_.Exception.InnerException.Message)"
            Start-Sleep -Seconds 3
        }
    }
    Write-Host "Created $zip"
}
finally {
    Pop-Location
}
