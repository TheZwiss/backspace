# Backspace no Debian 13 ARM64 via PRoot (Android 11) — instalação e correções

Atualizado em 2026-10-27. Este arquivo registra o que precisa ser reproduzido em
outros dispositivos. Nenhuma credencial é reproduzida aqui.

## 1. O que está rodando

| Serviço | Porta | Como inicia |
|---|---|---|
| Backspace (app + API + WebSocket) | 3000 | `node --import tsx/esm src/index.ts` em `/opt/backspace/packages/server` |
| LiveKit (SFU de voz/vídeo/tela) | 7880 sinalização, 7881 TCP ICE, 7882 UDP ICE | binário PRoot-patchado, ver §4 |
| Caddy (HTTPS/WSS) | 8443 (h1/h2/h3) | `caddy run --config /opt/caddy/Caddyfile` |

URLs (preferencial, sem instalar CA):

- Tailscale HTTPS: `https://backspace.<sua-tailnet>.ts.net` (certificado Let's Encrypt)
- LAN: `https://10.0.1.5:8443`
- Tailscale IP: `https://100.113.4.54:8443`
- Tailscale MagicDNS: `https://mi-9t-pro.<sua-tailnet>.ts.net:8443` (se o DNS do
  Tailscale estiver ativo no cliente)
- CA local: `https://10.0.1.5:8443/ca.crt`
- LiveKit interno: `ws://127.0.0.1:7880`; pelo Caddy: `wss://<host>:8443/livekit/`

## 2. Iniciar, parar e checar

```bash
/opt/backspace/start-stack.sh     # idempotente
/opt/backspace/status-stack.sh
/opt/backspace/stop-stack.sh
```

### Auto-start com o Termux

Já configurado:

- `/data/data/com.termux/files/home/backspace-autostart.sh` — sobe o Debian/PRoot
  em background, espera até 40 s pelo `tun1` do Tailscale e mantém o proot vivo
  (`exec sleep infinity`). Se o app já responde, sai sem duplicar nada.
- `/data/data/com.termux/files/home/.termux/boot/30-backspace` — entrada do
  Termux:Boot.
- Hook no `.profile` e `.bashrc` do Termux: abrir o Termux já sobe a stack.

Log: `~/backspace-boot.log`.

O pacote **Termux:Boot** não estava instalado (`pm list packages` mostra só
`com.termux`). Para iniciar junto com o **Android**, instale Termux:Boot pelo
F-Droid, abra uma vez e desative a otimização de bateria para Termux e
Termux:Boot. Sem esse app, o auto-start funciona apenas quando o Termux é aberto
(que é o caso coberto pelo `.profile`).

Teste manual do auto-start (com a stack parada):

```bash
# no Termux
~/backspace-autostart.sh
sleep 5
curl -s http://127.0.0.1:3000/api/health
```

Logs:

```bash
tail -f /var/log/backspace/server.log
tail -f /var/log/livekit/livekit.log
tail -f /var/log/caddy/caddy.log
```

Não há systemd funcional no PRoot. Se quiser subir no boot, use Termux:Boot ou
um script do gerenciador de inicialização do Android chamando
`/opt/backspace/start-stack.sh`.

## 3. Configuração do Backspace (`/opt/backspace/.env`)

Chaves necessárias (valores ficam só no `.env`, nunca no Git):

```dotenv
DOMAIN=localhost:3000
PORT=3000
HOST=0.0.0.0
JWT_SECRET=<gerar com: openssl rand -hex 32>
REGISTRATION_OPEN=true
LIVEKIT_URL=wss://10.0.1.5:8443/livekit/
LIVEKIT_URL_AUTO=1
LIVEKIT_API_KEY=<mesma chave do livekit.yaml>
LIVEKIT_API_SECRET=<mesmo secret do livekit.yaml>
```

`LIVEKIT_URL_AUTO=1` foi adicionado no código (`config.ts` e
`routes/livekit.ts`): quando o token é pedido via Caddy, o servidor devolve
`wss://<host-da-página>:8443/livekit/`. Assim LAN, IP Tailscale e MagicDNS
funcionam sem fixar um único endereço em `LIVEKIT_URL`. `LIVEKIT_URL` continua
sendo o fallback (e o endereço usado em federação).

As três permissões de voz padrão do `@everyone` já incluem `CONNECT`, `SPEAK` e
`STREAM`; o token emitido em `/api/livekit/token` contém
`microphone`, `camera`, `screen_share` e `screen_share_audio`.

## 4. LiveKit no PRoot — por que o binário oficial não sobe

O binário oficial travava em três pontos que dependem de netlink, bloqueado pelo
PRoot:

1. `getTCStats()` (telemetria Prometheus) faz `RTM_GETADDR` e espera para sempre.
2. `hwstats` tenta `lstat("/sys/fs/cgroup/cpu.stat")`; o PRoot nega e o processo
   aborta com `permission denied`.
3. Pion (`stdnet` → `anet.Interfaces` / `InterfaceAddrsByInterface`) usa netlink
   para listar interfaces e endereços; trava de forma intermitente no boot.

Correções aplicadas (binário em `/usr/local/bin/livekit-server.bin`, versão
1.13.11):

- `pkg/telemetry/prometheus/node_linux.go`: `getTCStats()` retorna `0,0,nil`.
- `github.com/livekit/protocol/utils/hwstats/cpu_linux.go`: `fileExists()` trata
  erro de `lstat` como “arquivo ausente”, caindo no fallback de `/proc`.
- `github.com/wlynxg/anet/interface.go`: `Interfaces`, `InterfaceAddrs` e
  `InterfaceAddrsByInterface` leem a env `LIVEKIT_PRORT_ADDRS` e montam a lista
  por `/sys/class/net`, sem netlink, quando ela existe.

O wrapper `/usr/local/bin/livekit-server` define:

```bash
LIVEKIT_PRORT_ADDRS=wlan0=10.0.1.5/24,tun1=100.113.4.54/32,lo=127.0.0.1/8
```

e executa o binário com `argv[0]=livekit-server`. Se os IPs ou nomes de
interface mudarem, atualize essa env.

Build reproduzível (quando atualizar a versão do LiveKit):

```bash
# Go 1.26+ (o livekit 1.13.11 exige go >= 1.26.0)
curl -L -o /tmp/go.tgz https://go.dev/dl/go1.26.0.linux-arm64.tar.gz
tar -C /tmp -xzf /tmp/go.tgz

curl -L -o /tmp/lk.tgz \
  https://github.com/livekit/livekit/archive/refs/tags/v1.13.11.tar.gz
tar -C /tmp -xzf /tmp/lk.tgz
cd /tmp/livekit-1.13.11

# 1) neutralizar getTCStats (remova o import "fmt" que ficar sem uso)
# 2) aplicar o arquivo de patch de anet em /tmp/anet-patched e adicionar:
#    replace github.com/wlynxg/anet => /tmp/anet-patched

GOROOT=/tmp/go PATH=/tmp/go/bin:$PATH GOMAXPROCS=4 CGO_ENABLED=1 \
  /tmp/go/bin/go build -trimpath -buildvcs=false -o /tmp/livekit-server ./cmd/server
```

Os arquivos corrigidos de referência estão em `/opt/livekit/patches/`.

## 5. Configuração do LiveKit (`/opt/livekit/livekit.yaml`)

```yaml
port: 7880
bind_addresses:
  - 0.0.0.0
rtc:
  node_ip: 100.113.4.54
  advertise_internal_ip: false
  ips:
    excludes:
      - 10.0.0.0/8
  use_external_ip: false
  udp_port: 7882
  tcp_port: 7881
logging:
  level: info
keys:
  <api-key>: <api-secret>

turn:
  enabled: true
  domain: backspace.<sua-tailnet>.ts.net
  cert_file: /opt/caddy/certs/backspace.crt
  key_file: /opt/caddy/certs/backspace.key
  udp_port: 3478        # TURN/UDP (também serve de STUN)
  tcp_port: 3479        # TURN/TCP sem TLS, encaminhado pelo nó backspace
  tls_port: 0           # desligado: 443 é impossível sem root; TCP 3479 basta
  relay_range_start: 30000
  relay_range_end: 40000
  allow_restricted_peer_cidrs:
    - 10.0.0.0/8
    - 100.64.0.0/10
    - 127.0.0.0/8
    - fd00::/8
```

O TURN/TLS na 443 não pode ser usado no Android sem root. O TURN/TCP 3479 é
publicado pelo `tailscale serve` com PROXY protocol v2, então o cliente recebe:

```
turn:100.113.4.54:3478?transport=udp
turn:backspace.<sua-tailnet>.ts.net:3479?transport=tcp
```

Se o firewall do cliente bloquear UDP, o TURN/TLS em 5349 é o fallback.

#### Candidatos ICE: só o IP do Tailscale (estado validado em 2026-11-08)

O servidor anuncia **um único** candidato de mídia: `100.113.4.54:7882/udp` (IP
do Tailscale do Android). `advertise_internal_ip: false` e
`ips.excludes: 10.0.0.0/8` mantêm o IP da LAN (`wlan0`) fora da lista.

**Por quê.** Com `advertise_internal_ip: true` o LiveKit anunciava dois
candidatos (`10.0.1.8` e `100.113.4.54`). Um cliente de fora (ex.: celular em 4G)
só alcançava o servidor através de um relé do TURN, e o ICE ficava trocando de
par entre os dois endereços: `ice reconnected or switched pair` aparecia a cada
2 a 6 segundos (47 vezes em 5 minutos), o que se via como picos de ping. Com um
só candidato, a mesma sessão ficou com **0 trocas** e **0 avisos** no log, e o
par escolhido passou a ser `udp host ↔ udp host` (sem `relay`).

**O que isso NÃO muda.** O bloco `turn:` continua ligado, de propósito: ele é o
fallback para quem não alcança o IP UDP. Quem tem só o compartilhamento do nó
`backspace` (e não o do nó Android `mi-9t-pro`) não consegue chegar a
`100.113.4.54:7882` e cai em TURN/TCP (`3479`), que é o pior caminho (bloqueio de
cabeça de fila do TCP dentro do WireGuard em userspace).

**Para os amigos terem UDP direto**, compartilhe também o nó Android: Tailscale
admin → Machines → `mi-9t-pro` → Share. A página e o sinal continuam entrando por
`https://backspace.<sua-tailnet>.ts.net`; só a mídia passa a usar o nó Android.
Abrir a porta no roteador não é opção atrás de CGNAT.

**Como conferir.** No painel de estatísticas da chamada, o par ativo deve ser
`udp` com tipo `host` ou `srflx`. `relay` com `tcp` é o fallback. No servidor:

```bash
grep -a "participant active" /var/log/livekit/livekit.log | tail -2   # connectionType: udp
grep -a "switched pair" /var/log/livekit/livekit.log | wc -l           # não deve crescer
```

**Custo.** Quem está na LAN também usa o caminho do Tailscale (mediana de cerca de
4,5 ms, contra cerca de 1,9 ms pela LAN pura). Para voltar ao comportamento
antigo, ponha `advertise_internal_ip: true`, remova o bloco `ips.excludes` e
reinicie o LiveKit.

Medições que descartaram outras causas (2026-11-08): o PRoot não é o gargalo
(eco UDP nativo no Termux e dentro do PRoot deram a mesma distribuição, jitter de
cerca de 1,5 a 2 ms, e `Seccomp: 2` está ativo); e o binário patchado é não-PIE,
então o Android não o executa fora do PRoot sem recompilar com
`-buildmode=pie`. O jitter de 7 a 9 ms que o painel mostra é jitter RTP, que
inclui o ritmo de envio, não só a rede.

Se o Tailscale estiver desligado, o candidato fica inútil e a chamada falha. Se os
IPs mudarem, ajuste `node_ip`, `ips.excludes`, `LIVEKIT_PRORT_ADDRS`, o SAN do
certificado e `LIVEKIT_URL`/`LIVEKIT_URL_AUTO`.

**Reiniciar o LiveKit sem matá-lo.** O PRoot usa `--kill-on-exit`: um
`proot-distro login ... livekit-server &` morre quando a sessão de login acaba.
Para reiniciar fora do `start-stack.sh`, rode numa sessão persistente:

```bash
pkill -x livekit-server   # com participantes, mande o sinal duas vezes
setsid nohup proot-distro login debian -- bash -lc \
  "cd /opt/livekit && livekit-server --config /opt/livekit/livekit.yaml >>/var/log/livekit/livekit.log 2>&1" \
  >/dev/null 2>&1 </dev/null &
```

## 6. Caddy (`/opt/caddy/Caddyfile`)

```caddyfile
{
	auto_https disable_redirects
}

https://localhost:8443, https://10.0.1.5:8443, https://100.113.4.54:8443, https://mi-9t-pro.<sua-tailnet>.ts.net:8443 {
	tls /opt/caddy/certs/backspace.crt /opt/caddy/certs/backspace.key

	handle /ca.crt {
		root * /opt/caddy
		file_server
	}

	handle_path /livekit/* {
		reverse_proxy 127.0.0.1:7880
	}

	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
```

O certificado é emitido pela CA local do Caddy e inclui:

```
DNS:localhost, DNS:mi-9t-pro.<sua-tailnet>.ts.net,
IP:127.0.0.1, IP:10.0.1.5, IP:100.113.4.54
```

O arquivo `backspace.crt` contém a **cadeia completa** (leaf + intermédio). Sem
o intermédio, clientes Go/diferentes navegadores recusam com
`certificate signed by unknown authority`.

Regenerar (validade de 365 dias):

```bash
cd /opt/caddy/certs
cat > ext.cnf <<'EOF'
subjectAltName=DNS:localhost,DNS:mi-9t-pro.<sua-tailnet>.ts.net,IP:127.0.0.1,IP:10.0.1.5,IP:100.113.4.54
extendedKeyUsage=serverAuth
keyUsage=critical,digitalSignature,keyEncipherment
basicConstraints=critical,CA:FALSE
EOF
openssl req -new -newkey rsa:2048 -nodes -keyout backspace.key \
  -out backspace.csr -subj "/CN=10.0.1.5"
openssl x509 -req -in backspace.csr \
  -CA /root/.local/share/caddy/pki/authorities/local/intermediate.crt \
  -CAkey /root/.local/share/caddy/pki/authorities/local/intermediate.key \
  -CAcreateserial -out backspace-leaf.crt -days 365 -extfile ext.cnf
cat backspace-leaf.crt \
  /root/.local/share/caddy/pki/authorities/local/intermediate.crt > backspace.crt
cp /root/.local/share/caddy/pki/authorities/local/root.crt /opt/caddy/ca.crt
caddy reload --config /opt/caddy/Caddyfile --adapter caddyfile
```

## 7. Instalar a CA nos clientes (recomendado)

Guia curto para distribuir: `/opt/backspace/CA-INSTALL.md`.

Sem isso, o navegador mostra aviso de certificado. Em HTTPS, é necessário
aceitar o aviso ao menos uma vez no host usado, senão o `wss://` do LiveKit pode
falhar silenciosamente.

O download também está disponível **sem TLS** em
`http://10.0.1.5:3000/ca.crt`, que é o jeito mais fácil de baixar antes de
confiar na CA.

Android 11:

1. Abra `http://10.0.1.5:3000/ca.crt` e baixe.
2. Configurações → Segurança → Criptografia e credenciais → Instalar certificado
   → Certificado de CA → selecione o arquivo.
3. Confirme o aviso do Android.

Desktop Linux (Debian/Ubuntu):

```bash
sudo cp /opt/caddy/ca.crt /usr/local/share/ca-certificates/backspace-ca.crt
sudo update-ca-certificates
```

Firefox usa o próprio store: Importar → Autoridades → `ca.crt`.

Windows (PowerShell como Administrador):

```powershell
Import-Certificate -FilePath .\backspace-ca.crt -CertStoreLocation Cert:\LocalMachine\Root
```

macOS:

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain backspace-ca.crt
```

Depois de instalar, **feche e reabra o Electron**. O Electron não oferece o
“continuar mesmo assim” do navegador; sem a CA ele falha com
`ERR_CERT_AUTHORITY_INVALID` antes mesmo de chegar no Backspace.

Alternativa apenas para teste, sem instalar a CA (insegura, desativa a
verificação de certificado do app inteiro):

```bash
# Linux
backspace --ignore-certificate-errors
# macOS
open -a Backspace --args --ignore-certificate-errors
# Windows: acrescente --ignore-certificate-errors ao destino do atalho
```

## 7b. HTTPS válido do Tailscale (sem CA nos clientes)

Foi criado um nó Tailscale userspace separado, chamado `backspace`
(`100.91.47.106`), dentro do Debian, e o `tailscale serve` publica:

```text
https://backspace.<sua-tailnet>.ts.net/          -> http://127.0.0.1:3000
https://backspace.<sua-tailnet>.ts.net/livekit   -> http://127.0.0.1:7880
```

O certificado é Let's Encrypt, então Chrome/Electron confiam sem instalar CA.
O Tailscale do Android continua ligado e mantém a mídia em `100.113.4.54`.

O `start-stack.sh` sobe o daemon userspace e reaplica o `serve` se necessário.
A auth key foi usada uma vez e apagada; o estado fica em
`/var/lib/tailscale-userspace`.

**Importante:** o nó `backspace` está no seu tailnet. Para alguém de outro
tailnet (por exemplo o usuário Helon21) acessar, compartilhe **apenas a máquina
`backspace`** com essa pessoa no painel do Tailscale (Machines → backspace →
Share). O TURN/TCP 3479 também passa por esse nó, então não é preciso
compartilhar o `mi-9t-pro`. É uma ação por pessoa, não por dispositivo, e não
exige CA.

## 8. Testes que foram executados e passaram

```bash
# HTTP/HTTPS
curl http://127.0.0.1:3000/api/health
curl -k https://10.0.1.5:8443/api/health
curl -k https://100.113.4.54:8443/api/health
curl -k --resolve mi-9t-pro.<sua-tailnet>.ts.net:8443:10.0.1.5 \
  https://mi-9t-pro.<sua-tailnet>.ts.net:8443/api/health

# LiveKit REST + credenciais
cd /opt/backspace/packages/server
LIVEKIT_LAN_URL=http://127.0.0.1:7880 node --import tsx/esm verify-livekit.ts

# WebSocket do app (auth -> ready)
# (validado com o JWT do usuário real; retornou {"type":"ready",...})

# Token do app, grants e URL dinâmica
# (validado para 10.0.1.5, 100.113.4.54, localhost e MagicDNS)
```

Mídia real (dois clientes LiveKit CLI pela WSS do Caddy):

```bash
cd /tmp
# lk: https://github.com/livekit/livekit-cli/releases (linux_arm64)
set -a; . /opt/backspace/.env; set +a
export LIVEKIT_URL=wss://10.0.1.5:8443/livekit
R=teste-$$
./lk room create "$R" --quiet
(timeout 20 ./lk room join -i sub --auto-subscribe "$R" > /tmp/sub.log 2>&1 &)
sleep 3
timeout 15 ./lk room join -i pub --publish-demo "$R" > /tmp/pub.log 2>&1
grep -E "track subscribed|published" /tmp/sub.log /tmp/pub.log
```

Resultado observado: publisher publicou H.264 simulcast e o subscriber assinou
o track de vídeo. O log do LiveKit mostrou `connectionType: udp` e candidatos
`10.0.1.5:7882` + `100.113.4.54:7882`.

Testes unitários:

```bash
cd /opt/backspace
pnpm --filter @backspace/server typecheck
pnpm --filter @backspace/server exec vitest run src/telemetry/payload.test.ts src/utils/csp.test.ts
pnpm --filter @backspace/web exec vitest run src/utils/screenShare src/hooks/useLiveKit
# 132 testes de tela/useLiveKit passaram
```

## 9. Compartilhamento de tela

- O token do Backspace já inclui `screen_share` e `screen_share_audio`.
- `getDisplayMedia` exige contexto seguro: use `https://...:8443` (não HTTP).
- Em desktop Chrome/Edge/Firefox, o botão de compartilhar abre o seletor do
  sistema/aba. Em Android, o suporte a `getDisplayMedia` varia por versão do
  Chrome; se o botão não abrir, o limite é do navegador Android, não do servidor.
- Áudio do sistema só é capturado onde o navegador suporta
  `getDisplayMedia({audio:...})`; o vídeo da tela funciona independentemente.

## 10. Limitações conhecidas / observações

- `tailscaled` dentro do Debian não funciona (netlink bloqueado). O IP
  `100.113.4.54` existe porque o app Tailscale do Android mantém a VPN. Não
  tente iniciar `tailscaled` dentro do PRoot.
- Abrir `http://<host>:3000` no navegador redireciona (somente navegação HTML)
  para `https://<host>:8443`; sem HTTPS o microfone/câmera/tela não funcionam.
- `ss`, `ip addr` e `netstat` podem falhar no PRoot (`netlink: permission
  denied`); use `curl`, `pgrep` e os scripts.
- Sem root Android, não há iptables/systemd. Firewall do roteador/Android não
  deve bloquear as portas 7880/7881/7882 e 8443.
- `DOMAIN=localhost:3000` é o valor atual; isso afeta federação/identidade, não
  voz/vídeo. Para federação, usar um domínio real (sem porta) e reavaliar.
- O servidor escuta 3000 em `0.0.0.0`; o acesso normal deve ser sempre pelo
  Caddy em 8443.
- `ffmpeg`/`ffprobe` foram instalados via `apt-get install -y ffmpeg` para
  thumbnails/metadados de vídeo.

## 11. Checklist para outro dispositivo

1. Debian ARM64 no PRoot com Node 24+, pnpm 10+, ffmpeg, Caddy e Go (só para
   compilar o LiveKit).
2. Copiar/instalar o binário LiveKit PRoot-patchado e o wrapper com os IPs
   corretos.
3. Copiar `/opt/livekit/livekit.yaml` e ajustar `node_ip`/chaves.
4. Copiar `/opt/backspace` (ou clonar) e recriar o `.env`; nunca reutilizar
   segredos de outro host sem necessidade.
5. Copiar o Caddyfile, gerar certificado com o SAN do novo host e publicar
   `/ca.crt`.
6. Iniciar com `/opt/backspace/start-stack.sh`.
7. Instalar a CA no navegador/celular.
8. Testar health HTTPS, WebSocket do app, token e mídia com dois clientes.
9. Abrir `https://<ip>:8443` em dois dispositivos e testar microfone, câmera e
   tela.
