# LadiesGo — Deploy próprio de mapas/serviços (VPS Oracle ARM, $0/mês)

Pacote pronto para **táxi em Luanda, Angola**: routing OSRM (car) + geocode Photon +
tiles vetor/raster + Postgres/PostGIS do app + nginx (proxy+cache+TLS) num
**VPS Ubuntu 22.04/24.04 ARM com 2 CPU + 12 GB (Oracle Always Free)**.

```
┌──────────┐   https://maps.TEUDOMINIO                ┌─────────────────────┐
│ App/Web/ │─── /route/*  (cache 1h)  ───────────────▶│ osrm:5000           │ Angola MLD car
│ Worker   │─── /search/* (cache 7d)  ──▶ nginx:80/443│ photon:2322         │ + opensearch:9200
│ Mobile   │─── /tiles/*  (cache 30d) ───────────────▶│ tileserver:8080     │ angola.mbtiles
└──────────┘                                          │ postgres:5432       │ dados do app (backup)
                                                      └─────────────────────┘
```

Ficheiros deste pacote (`selfhost/`):

| Ficheiro | Para que serve |
|---|---|
| `docker-compose.yml` | stack completa (versões pinned, limites de RAM, healthchecks) |
| `nginx.conf` | proxy+cache+rate-limit; bloco `:443` comentado até ao certbot (§8) |
| `.env.example` | copiar para `.env` e preencher (nunca commitar o `.env`) |
| `build-angola-data.sh` | gera dados Angola do zero (OSRM+Photon+tiles) — executável no VPS |
| `backup-postgres.sh` | pg_dump diário comprimido + retenção 7 dias (via cron) |
| `README-DEPLOY.md` | este guia |

> **NÃO uses Portugal.** O extract correcto é `africa/angola-latest.osm.pbf` do
> Geofabrik. Qualquer referência a `portugal-latest` nestes guias é erro — usa Angola.

---

## 1. O que o DONO faz à mão vs o que já é automático

### 1A. DONO faz à mão (não automatizável — contas, DNS, chaves, cliques)

1. **Conta Oracle Cloud** (trial + upgrade a Always Free) — registo, cartão (só validação), MFA. §2.
2. **Criar o VPS** na consola Oracle: shape Ampere A1 **2 OCPU + 12 GB**, Ubuntu 22.04/24.04 ARM, VCN + subnet pública + Internet Gateway + NSG a abrir **22/80/443**, **IP público reservado**, par de chaves SSH. §3.
3. **DNS**: criar `A maps.TEUDOMINIO → <IP-reservado>` (Cloudflare ou outro) + esperar propagação. §4.
4. **Preencher `.env`**: `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD` (gera com `openssl rand -hex 16`). §5.
5. **Primeira emissão TLS**: correr o comando certbot do §8 e descomentar o bloco `:443`.
6. **Apontar o app**: trocar as URLs no Worker/front/mobile (§10) + deploy Cloudflare/Railway. É código teu, não é automático.
7. **Guardar fora do VPS**: cópia do `.env` + pasta `letsencrypt` + 1 backup Postgres (1×/mês, ex.: Drive cifrado). §9.
8. **Pagar $0 e vigiar**: confirmar que o shape está em *Always Free* (não trial) e activar alertas de reboot.

### 1B. Já fica automático (só correr comandos deste guia)

- [x] Instalação Docker + swap + firewall (§5) — script apt.
- [x] Download + checksum Angola + build OSRM/Photon/tiles (`build-angola-data.sh`, §6).
- [x] Subir/actualizar stack (`docker compose up -d`, §7/§11).
- [x] TLS renovação (`certbot renew` via systemd timer 2×/dia, §8).
- [x] Backup Postgres diário 03:15 + retenção 7 dias (cron, §9).
- [x] Cache nginx + rate-limit (sempre ligado, `nginx.conf`).
- [x] Watchtower **desligado por defeito**; actualização manual mensal documentada (§11).

---

## 2. Conta Oracle (o DONO faz — só documentado aqui, ~20 min + espera)

1. Vai a `cloud.oracle.com` → *Sign Up* → país Angola/Portugal, email do dono, cartão para verificação (não cobra no Free Tier).
2. Activa **MFA** (Authenticator) na conta root.
3. No billing, confirma que tens acesso a **Always Free** (não gastes créditos do trial de 30 dias com shapes pagos).
4. Cria um *compartment* `ladiesgo` (opcional mas recomendado) para não misturar recursos.

> Não partilhes a password root. Cria um utilizador IAM `ops` + grupo `admins` para o dia-a-dia.

## 3. Criar o VPS (consola Oracle, ~10 min)

1. *Compute → Instances → Create*: nome `ladiesgo-maps`, compartment `ladiesgo`.
2. **Shape**: `VM.Standard.A1.Flex` (Ampere ARM) → **2 OCPU, 12 GB RAM**. (Se disser "out of capacity" no trial, tenta outra *availability domain* ou espera — é o erro mais comum do Free Tier.)
3. **Imagem**: Canonical Ubuntu **24.04 Minimal aarch64** (ou 22.04 se 24.04 não aparecer).
4. **Rede**: cria VCN nova `ladiesgo-vcn` (10.0.0.0/16) + subnet pública + Internet Gateway + route table. **NSG/ingress**: abrir `22/tcp` (o teu IP), `80/tcp` (0.0.0.0/0), `443/tcp` (0.0.0.0/0).
5. **Boot volume**: 50 GB (mínimo; 100 GB se disponível em Always Free na tua região — o build precisa de ~15 GB livres).
6. **SSH**: gera novo par ou cola a tua `~/.ssh/id_ed25519.pub`. Guarda a privada — sem ela perdes o VPS.
7. *Create* → espera `Running` → **reserva o IP**: *VNIC → Public IP → Reserve* (senão muda em cada reboot).
8. Liga-te: `ssh -i ~/.ssh/tua-chave ubuntu@<IP-RESERVADO>`.

## 4. DNS (DONO faz, 5 min + propagação)

No teu DNS (ex.: Cloudflare):

```
A  maps.TEUDOMINIO   →  <IP-RESERVADO>   (Proxy OFF / DNS-only durante o certbot)
```

Verifica do teu PC: `nslookup maps.TEUDOMINIO` → tem de responder o IP. Só avança para o §8 quando isto resolver.

## 5. Bootstrap do VPS vazio (copy-paste, ~10 min)

```bash
ssh -i ~/.ssh/tua-chave ubuntu@<IP>
sudo apt update && sudo apt full-upgrade -y

# Docker oficial (não o do apt Ubuntu, que é antigo)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
docker --version && docker compose version   # espera Docker >=26 e compose v2

# swap 4G (segurança p/ picos do osrm-customize) + firewall + relógio
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable
timedatectl set-timezone Africa/Luanda

# pasta do projecto
sudo mkdir -p /opt/ladiesgo && sudo chown $USER:$USER /opt/ladiesgo
cd /opt/ladiesgo
# copia ESTA pasta selfhost/ para aqui (do teu PC):
#   scp -i ~/.ssh/tua-chave -r selfhost/* ubuntu@<IP>:/opt/ladiesgo/
cp .env.example .env
nano .env   # preenche DOMAIN, ACME_EMAIL, POSTGRES_PASSWORD (openssl rand -hex 16)
chmod 600 .env
mkdir -p data/osrm data/photon data/tiles backups certbot-www
```

## 6. Dados de Angola (Geofabrik → OSRM + Photon + tiles)

Fonte única: `https://download.geofabrik.de/africa/angola-latest.osm.pbf`
(**Angola, não Portugal**). O script faz tudo; os comandos manuais estão abaixo para auditoria.

```bash
cd /opt/ladiesgo
chmod +x build-angola-data.sh backup-postgres.sh
./build-angola-data.sh
# ou sem tiles (rápido, só routing+search): ./build-angola-data.sh --skip-tiles
```

Equivalente manual (o que o script corre por ti):

```bash
# A. download + checksum
cd /opt/ladiesgo/data/osrm
wget -c https://download.geofabrik.de/africa/angola-latest.osm.pbf -O angola-latest.osm.pbf
wget -q -O angola-latest.osm.pbf.md5 https://download.geofabrik.de/africa/angola-latest.osm.pbf.md5
md5sum -c angola-latest.osm.pbf.md5

# B. OSRM car MLD (perfil /opt/car.lua DENTRO da imagem;采集 RAM ~6-8GB, 10-25 min)
docker run --rm -v $PWD:/data osrm/osrm-backend:v5.27.1 \
  osrm-extract -p /opt/car.lua /data/angola-latest.osm.pbf
docker run --rm -v $PWD:/data osrm/osrm-backend:v5.27.1 \
  osrm-partition /data/angola-latest.osrm
docker run --rm -v $PWD:/data osrm/osrm-backend:v5.27.1 \
  osrm-customize /data/angola-latest.osm
...[truncated 10042 chars]