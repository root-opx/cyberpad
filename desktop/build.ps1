# Builds the CyberPad desktop app and packages it as dist/CyberPad-win-x64-<version>.zip and dist/CyberPad-Setup-<version>.exe.
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
$setupObj = Join-Path $dist 'obj-setup'

# Paths are passed to MSBuild as -p:Name=value, where ';' separates values and '%' starts an escape.
if ($root.Contains(';') -or $root.Contains('%')) {
    throw "The repository path contains ';' or '%', which MSBuild properties cannot carry: $root. Move the repository to a folder without them."
}

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
    Write-Host '== 1/8 npm test'
    & npm test
    Assert-ExitCode 'npm test'

    Write-Host '== 2/8 dotnet test'
    & dotnet test $sln -c Release
    Assert-ExitCode 'dotnet test'

    Write-Host '== 3/8 vulnerable package audit'
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

    Write-Host '== 4/8 dotnet publish'
    if (Test-Path -LiteralPath $publishDir) {
        Remove-Item -LiteralPath $publishDir -Recurse -Force
    }
    # No .pdb (its embedded path names the build machine's user folder) and no package XML docs in the release.
    & dotnet publish $project -c Release -r win-x64 --self-contained true `
        -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:DebugType=none -p:GenerateDocumentationFile=false -p:PublishReferencesDocumentationFiles=false `
        -o $publishDir
    Assert-ExitCode 'dotnet publish'

    Write-Host '== 5/8 zip'
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

    if (Test-Path -LiteralPath $setupObj) {
        Remove-Item -LiteralPath $setupObj -Recurse -Force
    }

    Write-Host '== 6/8 build Uninstall.exe'
    # DebugType=none: no .pdb (its embedded path names the build machine's user folder). The library's
    # source files are compiled into each program, so no DLL is built or shipped alongside.
    $uninstallOut = Join-Path $setupObj 'uninstall'
    & dotnet build (Join-Path $desktop 'CyberPad.Uninstall\CyberPad.Uninstall.csproj') -c Release --no-incremental `
        -p:DebugType=none -p:Version=$version -o $uninstallOut
    Assert-ExitCode 'dotnet build Uninstall'
    $uninstallExe = Join-Path $uninstallOut 'Uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstallExe -PathType Leaf)) {
        throw 'Uninstall.exe was not built.'
    }

    Write-Host '== 7/8 build CyberPad-Setup.exe'
    $setupBuilt = Join-Path $setupObj 'setup'
    & dotnet build (Join-Path $desktop 'CyberPad.Setup\CyberPad.Setup.csproj') -c Release --no-incremental `
        -p:DebugType=none -p:Version=$version -p:PayloadZip=$zip -p:UninstallerExe=$uninstallExe -o $setupBuilt
    Assert-ExitCode 'dotnet build Setup'
    $setupExe = Join-Path $setupBuilt 'CyberPad-Setup.exe'

    Write-Host '== 8/8 check and copy the setup file'
    if (-not (Test-Path -LiteralPath $setupExe -PathType Leaf)) {
        throw 'CyberPad-Setup.exe was not built.'
    }
    $setupSize = (Get-Item -LiteralPath $setupExe).Length
    $zipSize = (Get-Item -LiteralPath $zip).Length
    if ($setupSize -lt $zipSize) {
        throw "CyberPad-Setup.exe ($setupSize bytes) is smaller than the zip ($zipSize bytes): the payload was not embedded."
    }
    if ($setupSize -gt 150MB) {
        throw "CyberPad-Setup.exe is larger than 150 MB ($setupSize bytes)."
    }
    # Read the built programs' metadata without running them: the setup file must carry exactly its two
    # resources, and neither program may reference anything but .NET Framework assemblies (in particular no
    # CyberPad.Install.dll, which Windows would look for beside the exe).
    $frameworkAssemblies = @('mscorlib', 'System', 'System.Core', 'System.Drawing', 'System.Windows.Forms', 'System.IO.Compression', 'System.IO.Compression.FileSystem')
    foreach ($program in @($setupExe, $uninstallExe)) {
        $metadata = [Reflection.Assembly]::ReflectionOnlyLoad([IO.File]::ReadAllBytes($program))
        $foreign = @($metadata.GetReferencedAssemblies() | Where-Object { $frameworkAssemblies -notcontains $_.Name } | ForEach-Object { $_.Name })
        if ($foreign.Count -gt 0) {
            throw ("$(Split-Path -Leaf $program) references non-framework assemblies:`n" + ($foreign -join "`n"))
        }
        if ($program -eq $setupExe) { $setupMetadata = $metadata }
    }
    $resources = @($setupMetadata.GetManifestResourceNames() | Sort-Object)
    if ($resources.Count -ne 2 -or $resources -cnotcontains 'payload.zip' -or $resources -cnotcontains 'Uninstall.exe') {
        throw ("CyberPad-Setup.exe must contain exactly payload.zip and Uninstall.exe; it has: " + ($resources -join ', '))
    }
    $setupFinal = Join-Path $dist "CyberPad-Setup-$version.exe"
    Copy-Item -LiteralPath $setupExe -Destination $setupFinal -Force
    $strayPdb = @(Get-ChildItem -LiteralPath $dist -Filter '*.pdb' -File)
    if ($strayPdb.Count -gt 0) {
        throw ("A .pdb file is shipped in dist:`n" + (($strayPdb | ForEach-Object { $_.Name }) -join "`n"))
    }
    Write-Host "Created $setupFinal"
}
finally {
    # Cleaned on failure too.
    if (Test-Path -LiteralPath $setupObj) {
        Remove-Item -LiteralPath $setupObj -Recurse -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}
