# Tailscale no Debian/PRoot no Android

Runbook da exposição HTTPS usada para acessar o Backspace pelo endereço:

```text
https://backspace.tail4e495d.ts.net/
```

Última recuperação validada em 2026-10-29, com o Backspace, o LiveKit e o
proxy HTTPS respondendo corretamente.

## Topologia

| Componente | Local | Uso |
|---|---|---|
| Tailscale Android | `mi-9t-pro` | Mantém a VPN do Android |
| Tailscale no PRoot | `backspace` | Publica os serviços do Debian em userspace networking |
| Backspace | `127.0.0.1:3000` | Interface, API e WebSocket |
| LiveKit | `127.0.0.1:7880` | Sinalização de voz, vídeo e compartilhamento de tela |
| TURN/TCP | `127.0.0.1:3479` | Fallback de mídia quando UDP não funciona |
| Tailscale Serve | HTTPS `443` | Entrada HTTPS com certificado gerenciado |

O endereço canônico é publicado pelo nó `backspace`. O nó Android
`mi-9t-pro` é separado e não deve ser usado como URL principal.

O roteamento HTTPS atual é:

```text
https://backspace.tail4e495d.ts.net/         -> http://127.0.0.1:3000
https://backspace.tail4e495d.ts.net/livekit  -> http://127.0.0.1:7880
backspace.tail4e495d.ts.net:3479             -> tcp://127.0.0.1:3479
```

O encaminhamento TURN/TCP precisa usar PROXY protocol v2; caso contrário, o
LiveKit recebe `127.0.0.1` como endereço do cliente e as sessões de mídia podem
falhar.

## Inicialização correta

No Debian/PRoot, o daemon precisa de um `--statedir` persistente. Sem isso, o
Tailscale pode falhar ao gerar o certificado com `no TailscaleVarRoot`.

```bash
mkdir -p /var/lib/tailscale-userspace /var/run/tailscale
chmod 700 /var/lib/tailscale-userspace

setsid nohup /usr/sbin/tailscaled \
  --tun=userspace-networking \
  --statedir=/var/lib/tailscale-userspace \
  --state=/var/lib/tailscale-userspace/tailscaled.state \
  --socket=/var/run/tailscale/tailscaled.sock \
  --port=41641 \
  >>/var/log/tailscale-userspace.log 2>&1 </dev/null &
```

Depois de o socket aparecer, restaure o nome e as rotas do Serve:

```bash
TS_SOCK=/var/run/tailscale/tailscaled.sock

tailscale --socket="$TS_SOCK" up \
  --hostname=backspace \
  --accept-dns=false

tailscale --socket="$TS_SOCK" serve --bg --yes --https=443 \
  --set-path /livekit http://127.0.0.1:7880

tailscale --socket="$TS_SOCK" serve --bg --yes --https=443 \
  http://127.0.0.1:3000

tailscale --socket="$TS_SOCK" serve --bg --yes \
  --tcp=3479 --proxy-protocol=2 tcp://127.0.0.1:3479
```

Não é necessário remover ou regerar o estado autenticado durante uma simples
reinicialização.

## Diagnóstico

Comece pelos serviços locais; uma falha local não deve ser tratada como falha
de DNS ou de certificado:

```bash
curl -fsS --max-time 5 http://127.0.0.1:3000/api/health
curl -fsS --max-time 5 http://127.0.0.1:7880/
```

Depois confira o daemon e as rotas publicadas:

```bash
TS_SOCK=/var/run/tailscale/tailscaled.sock

pgrep -af '^tailscaled --tun=userspace-networking'
test -S "$TS_SOCK" && echo "socket OK" || echo "socket ausente"
tailscale --socket="$TS_SOCK" status
tailscale --socket="$TS_SOCK" serve status
```

Falhas recorrentes observadas:

1. **Socket morto:** existia `/var/run/tailscale/tailscaled.sock`, mas não
   havia processo `tailscaled` correspondente. Um novo daemon pode encontrar o
   socket antigo. Confirme primeiro com `pgrep`; se o PID realmente não existir,
   remova somente esse socket e reinicie o comando completo da seção anterior.
2. **Nome do nó alterado:** o nó apareceu temporariamente como
   `backspace-old`, então não havia destino para
   `backspace.tail4e495d.ts.net`. O nome deve voltar a ser `backspace`.
3. **`--statedir` ausente:** o certificado falhava e `tailscale cert` retornava
   HTTP 500 com `no TailscaleVarRoot`. Mantenha o `--statedir` e o `--state`
   apontando para `/var/lib/tailscale-userspace`.

Valide o certificado pela própria URL:

```bash
curl -fsSI https://backspace.tail4e495d.ts.net/
curl -fsSI https://backspace.tail4e495d.ts.net/livekit
```

No diagnóstico realizado, o certificado Let's Encrypt apresentava
CN/SAN `backspace.tail4e495d.ts.net` e validade até 2027-01-25.

## Serve, Funnel e compartilhamento

`tailscale serve` publica apenas para a tailnet e para máquinas compartilhadas
por convite. Para amigos entrarem na instância atual:

1. Mantenha o MagicDNS habilitado na tailnet que possui o nó `backspace`.
2. Compartilhe o nó `backspace` em **Machines → backspace → Share**.
3. Garanta que as ACLs permitam acesso de entrada à porta `443`.
4. Envie o FQDN exato `https://backspace.tail4e495d.ts.net/`.

Compartilhar o IP `100.91.47.106` isoladamente não substitui o convite de
máquina. Também não é necessário compartilhar o nó Android `mi-9t-pro`.

`Funnel` é somente necessário se o acesso precisar funcionar para usuários sem
um convite do Tailscale. Ele expõe o serviço à internet pública e deve ser
tratado como uma decisão de segurança separada.

## Boot no Termux

Os arquivos operacionais são:

```text
/data/data/com.termux/files/home/.termux/boot/30-backspace
/data/data/com.termux/files/home/backspace-autostart.sh
/opt/backspace/start-stack.sh
```

O `start-stack.sh` já inicia o `tailscaled` em userspace networking com
`--statedir`, configura o Serve e atualiza o encaminhamento TURN/TCP. Mantenha
o Termux e o Termux:Boot fora da otimização de bateria.

## TeamSpeak

O início automático do TeamSpeak foi desativado de forma reversível. O arquivo
abaixo foi preservado e apenas perdeu a permissão de execução:

```text
/data/data/com.termux/files/home/.termux/boot/20-teamspeak-tailnet
```

Estado atual: modo `600`. Para reativar:

```bash
chmod 700 "$HOME/.termux/boot/20-teamspeak-tailnet"
```

## Dados que não devem ser removidos

Preserve o estado autenticado do Tailscale e os dados da instância:

```text
/var/lib/tailscale-userspace/
/opt/backspace/data/backups/
```

Não versione `tailscaled.state`, chaves de autenticação, certificados privados
ou conteúdo do `.env`.
