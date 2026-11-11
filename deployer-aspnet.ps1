<#
.SYNOPSIS
  Publie la version ASP.NET Core de l'outil d'administration MegaBac dans un dossier
  (par défaut le dossier de test) : application compilée + interface (wwwroot) + web.config IIS.

.DESCRIPTION
  - Compile et publie backend-aspnet/ (l'interface outil-admin/ est copiée dans wwwroot par le build).
  - Le dossier wwwroot de destination est vidé avant copie (pas de fichiers obsolètes).
  - Si appsettings.json existe déjà dans la destination, il est CONSERVÉ (il contient votre
    mot de passe haché et le chemin des données). Sinon, le modèle est copié : à renseigner.

.EXAMPLE
  .\deployer-aspnet.ps1
  .\deployer-aspnet.ps1 -Destination D:\autre\dossier
#>
param(
    [string]$Destination = (Join-Path (Split-Path $PSScriptRoot -Parent) 'Tests\MegabacAdmin'),
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'

$projet = Join-Path $PSScriptRoot 'backend-aspnet\MegabacAdmin.csproj'
if (-not (Test-Path $projet)) { throw "Projet introuvable : $projet" }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw "dotnet (SDK .NET) est introuvable dans le PATH." }

$temp = Join-Path ([IO.Path]::GetTempPath()) ('megabacadmin-publish-' + [guid]::NewGuid().ToString('N'))

try {
    Write-Host "Publication ($Configuration)..." -ForegroundColor Cyan
    dotnet publish $projet -c $Configuration -o $temp --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish a échoué (code $LASTEXITCODE)." }

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null

    # Interface : on repart d'un wwwroot propre.
    $wwwDest = Join-Path $Destination 'wwwroot'
    if (Test-Path $wwwDest) { Remove-Item $wwwDest -Recurse -Force }

    $configDest = Join-Path $Destination 'appsettings.json'
    $configExiste = Test-Path $configDest

    Write-Host "Copie vers $Destination ..." -ForegroundColor Cyan
    # IIS (hébergement in-process) verrouille MegabacAdmin.dll : app_offline.htm arrête
    # l'application le temps de la copie (elle redémarre dès que le fichier est supprimé).
    $offline = Join-Path $Destination 'app_offline.htm'
    Set-Content -Path $offline -Value '<html><body>Mise à jour en cours…</body></html>' -Encoding UTF8
    try {
        Start-Sleep -Seconds 2
        Get-ChildItem $temp -Force | ForEach-Object {
            if ($configExiste -and $_.Name -eq 'appsettings.json') { return } # config conservée
            Copy-Item $_.FullName -Destination $Destination -Recurse -Force
        }
    }
    finally {
        Remove-Item $offline -Force -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "Terminé." -ForegroundColor Green
    if ($configExiste) {
        Write-Host "appsettings.json existant conservé."
    } else {
        Write-Host "appsettings.json (modèle) copié : renseigne Admin:DataPath, Admin:Username et Admin:PasswordHash." -ForegroundColor Yellow
        Write-Host "  Hash : dotnet MegabacAdmin.dll --hash `"ton mot de passe`""
    }
    Write-Host "Lancer : cd `"$Destination`" ; dotnet MegabacAdmin.dll   (ou site IIS pointant sur ce dossier)"
}
finally {
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
