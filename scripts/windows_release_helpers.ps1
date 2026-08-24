function Get-DownanyElectronDist {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$DesktopPath
    )

    $electronExecutable = Join-Path $DesktopPath "node_modules\electron\dist\electron.exe"
    if (-not (Test-Path -LiteralPath $electronExecutable -PathType Leaf)) {
        throw "未找到 Electron runtime: $electronExecutable"
    }

    return "node_modules/electron/dist"
}

function Get-DownanyElectronBuildArguments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$DesktopPath
    )

    $electronDist = Get-DownanyElectronDist -DesktopPath $DesktopPath
    return @(
        "run"
        "dist:win"
        "--"
        "--config.electronDist=$electronDist"
    )
}
