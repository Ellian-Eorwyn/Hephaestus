$ErrorActionPreference = "Stop"

$repo = "Ellian-Eorwyn/Hephaestus"
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"

Write-Host "Fetching latest release from $repo..."
$release = Invoke-RestMethod -Uri $apiUrl -ErrorAction Stop

$version = $release.tag_name
if ([string]::IsNullOrEmpty($version)) {
    Write-Error "Could not determine latest release version."
    exit 1
}

Write-Host "Latest version is $version"

# Find the exe asset
$exeAsset = $release.assets | Where-Object { $_.name -like "*.exe" } | Select-Object -First 1

if ($null -eq $exeAsset) {
    Write-Error "Could not find .exe installer in the latest release."
    exit 1
}

$downloadUrl = $exeAsset.browser_download_url
$installerPath = Join-Path $env:TEMP "Hephaestus-Installer.exe"

Write-Host "Downloading $downloadUrl..."
Invoke-WebRequest -Uri $downloadUrl -OutFile $installerPath -ErrorAction Stop

Write-Host "Running installer..."
# /S runs the NSIS installer silently
Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait

Write-Host "Installation complete!"
