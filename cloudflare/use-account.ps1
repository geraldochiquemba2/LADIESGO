param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('old', 'new')]
  [string]$Account
)

# Troca a conta Cloudflare ativa do wrangler SEM login/logout (o logout revoga o token).
#   old = fddsfds45@gmail.com          (conta do Pages: ladiesgo.pages.dev)
#   new = isabelcanjamba62@gmail.com   (conta da API Worker: ladiesgo-api.ladiesgo-angola.workers.dev)
# Uso:  .\use-account.ps1 old   |   .\use-account.ps1 new

$cfg = Join-Path $env:USERPROFILE '.wrangler\config'
$src = Join-Path $cfg "default.$($Account)account.toml"

if (-not (Test-Path -LiteralPath $src)) {
  Write-Error "Credenciais nao encontradas: $src"
  exit 1
}

Copy-Item -LiteralPath $src -Destination (Join-Path $cfg 'default.toml') -Force
Write-Output "A usar a conta: $Account ($src)"

$wrangler = Join-Path $PSScriptRoot 'api-worker\node_modules\.bin\wrangler.cmd'
if (Test-Path -LiteralPath $wrangler) {
  & $wrangler whoami
} else {
  Write-Output "wrangler nao encontrado em $wrangler (credenciais ja trocadas)."
}
