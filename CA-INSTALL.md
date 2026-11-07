# Instalar a CA do Backspace (uma vez por dispositivo)

O servidor usa uma CA local. Navegador permite “continuar mesmo assim”, mas o
**Electron não** — ele precisa que a CA esteja instalada no sistema.

Download (sem TLS, para funcionar antes da CA estar instalada):

```
http://10.0.1.5:3000/ca.crt
```

Também disponível em `https://10.0.1.5:8443/ca.crt` depois que a CA estiver
instalada.

Fingerprint SHA-256 da CA:

```
29:AE:77:6A:52:20:19:BB:4E:A3:28:29:C0:63:39:BB:A0:7A:B3:AA:00:1C:4C:7C:8E:FE:B7:2C:A6:2E:D2:93
```

Depois de instalar, **feche e reabra o Electron**.

## Android 11

1. Abra `http://10.0.1.5:3000/ca.crt` no Chrome e baixe.
2. Configurações → Segurança → Criptografia e credenciais → Instalar certificado
   → Certificado de CA → escolha o arquivo.
3. Confirme o aviso do Android.

## Windows

1. Baixe o `ca.crt`.
2. Clique com o botão direito → Instalar Certificado.
3. Computador local → Colocar todos os certificados no repositório a seguir →
   **Autoridades de Certificação Raiz Confiáveis**.
4. Feche e reabra o Backspace.

PowerShell como Administrador:

```powershell
Invoke-WebRequest http://10.0.1.5:3000/ca.crt -OutFile "$env:TEMP\backspace-ca.crt"
Import-Certificate -FilePath "$env:TEMP\backspace-ca.crt" -CertStoreLocation Cert:\LocalMachine\Root
```

## Linux (Debian/Ubuntu)

```bash
curl -fsS http://10.0.1.5:3000/ca.crt -o /tmp/backspace-ca.crt
sudo cp /tmp/backspace-ca.crt /usr/local/share/ca-certificates/backspace-ca.crt
sudo update-ca-certificates

# Electron/Chrome também usam o banco NSS:
sudo apt-get install -y libnss3-tools
mkdir -p "$HOME/.pki/nssdb"
certutil -d "sql:$HOME/.pki/nssdb" -A -t "C,," -n Backspace-CA -i /tmp/backspace-ca.crt
```

## macOS

```bash
curl -fsS http://10.0.1.5:3000/ca.crt -o ~/Downloads/backspace-ca.crt
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain ~/Downloads/backspace-ca.crt
```

## iOS/iPadOS

1. Baixe o `.crt` no Safari.
2. Ajustes → Geral → VPN e Gerenciamento de Dispositivo → instale o perfil.
3. Ajustes → Geral → Sobre → Ajustes de Confiança de Certificado → ative a
   confiança total para “Caddy Local Authority”.

## Observações

- Instalação é **uma vez por dispositivo**, não por usuário/navegador.
- Em redes diferentes use `https://100.113.4.54:8443` ou o nome MagicDNS.
- Não use `http://...:8443`: essa porta é TLS e responde `400`.
- O certificado do site é renovado sem trocar a CA raiz; nesse caso não é
  preciso reinstalar em cada aparelho.


## Teste de portas no Windows (PowerShell)

```powershell
Test-NetConnection mi-9t-pro.<sua-tailnet>.ts.net -Port 5349
Test-NetConnection mi-9t-pro.<sua-tailnet>.ts.net -Port 3479
Test-NetConnection mi-9t-pro.<sua-tailnet>.ts.net -Port 8443
```

Os três devem mostrar `TcpTestSucceeded : True`.

`Test-NetConnection` testa **TCP**, não UDP. A porta UDP 3478 não aparece
como “True” nesse teste mesmo estando funcionando.

Conferir se a CA está instalada:

```powershell
certutil -store Root | findstr /i "Caddy"
```

Se não listar `Caddy Local Authority`, o TURN/TLS vai falhar com
`unknown certificate` mesmo com a porta 5349 aberta.
