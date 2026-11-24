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
    & dotnet publish $project -c Release -r win-x64 --self-contained true `
        -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o $publishDir
    Assert-ExitCode 'dotnet publish'

    Write-Host '== 5/5 zip'
    [xml]$xml = Get-Content -LiteralPath $csproj -Raw
    $version = $null
    foreach ($group in @($xml.Project.PropertyGroup)) {
        if ($group.Version) { $version = [string]$group.Version; break }
    }
    if ($version -notmatch '^\d+\.\d+\.\d+$') {
        throw 'Could not read a valid <Version> from the .csproj.'
    }
    $zip = Join-Path $dist "CyberPad-win-x64-$version.zip"
    # Antivirus or the indexer can briefly lock freshly published files, so retry a few times.
    $zipped = $false
    for ($attempt = 1; $attempt -le 5 -and -not $zipped; $attempt++) {
        try {
            Compress-Archive -Path (Join-Path $publishDir '*') -DestinationPath $zip -Force
            $zipped = $true
        } catch {
            if ($attempt -eq 5) { throw }
            Write-Host "Zip attempt $attempt failed, retrying: $($_.Exception.Message)"
            Start-Sleep -Seconds 3
        }
    }
    Write-Host "Created $zip"
}
finally {
    Pop-Location
}
