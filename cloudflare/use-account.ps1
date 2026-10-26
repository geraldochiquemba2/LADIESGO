param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('old', 'new')]
  [string]$Account
)

# CONTA OFICIAL (2026-10-26): rerererer...670@gmail.com (default.rerere670account.toml).
# Este script old/new e LEGADO; nao usar para Pages nem para o Worker estatico.
# Troca a conta Cloudflare ativa do wrangler SEM login/logout (o logout revoga o token).
#   old = fddsfds45@gmail.com          (LEGADO: API ladiesgo-api.ladiesgo-ao.workers.dev)
#   new = isabelcanjamba62@gmail.com   (LEGADO/em espera: ladiesgo-api.ladiesgo-angola.workers.dev)
# Uso:  .\use-account.ps1 old   |   .\use-account.ps1 new
#
# ATENCAO (incidente 2026-10-17): este script copia .<conta> -> default.toml, mas o wrangler RENOVA
# e RODA o token em default.toml e NAO o escreve de volta no ficheiro da conta. Se trocar de conta
# depois de um refresh, restaura um token velho e o login passa a dar
#   "Failed to fetch auth token: 400 Bad Request" / "Not logged in"
# -> perde-se o acesso sem se poder fazer deploy. Antes de trocar, faca BACKUP do token atual, ex.:
#   Copy-Item "$env:USERPROFILE\.wrangler\config\default.toml" `
#             "$env:USERPROFILE\.wrangler\config\default.<conta-atual>.toml" -Force
# Se o login ja estiver invalido, recuperar com `wrangler login` (NUNCA `wrangler logout`).
# TODO: no fim, guardar default.toml de volta no ficheiro da conta em vez de so ler.

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
