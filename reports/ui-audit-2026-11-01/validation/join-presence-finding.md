# Atraso ao aparecer na chamada

Reproduzido nas duas direções, com Alice e Bob reais no Electron. Foram 10 entradas iniciais e 6 entradas adicionais aguardando remoção completa do participante anterior da store, lista do canal e DOM antes de repetir. Microfones silenciados; sem câmera ou compartilhamento nesses testes de entrada.

## Medições mais controladas

| Entrando | Rodada | Presença WebSocket (ms) | Aviso LiveKit (ms) | Inserção no DOM (ms) | Store para DOM (ms) |
| --- | --- | --- | --- | --- | --- |
| bob | 0 | 221 | 88 | 94 | 5 |
| bob | 1 | 166 | 2961 | 2964 | 3 |
| bob | 2 | 176 | 791 | 796 | 5 |
| alice | 0 | 161 | 90 | 96 | 6 |
| alice | 1 | 167 | 2980 | 2983 | 3 |
| alice | 2 | 170 | 2889 | 2892 | 3 |

Nenhuma long task foi registrada durante essas seis medições. Os pedidos HTTP de token ficaram entre 4 e 6 ms. O último marco de apresentação é uma aproximação por dois requestAnimationFrame; não é uma medição física do monitor. A entrada no DOM foi observada por MutationObserver.

## Causa confirmada e amplificação na aplicação

O binário em execução retorna `livekit-server version 1.9.11`. Nessa versão, `subscriberUpdateInterval = 3 * time.Second` (room.go:51); `PushAndDequeueUpdates` enfileira atualizações quando não são imediatas e o participante não é publisher (room.go:1996-2033). `changeUpdateWorker` esvazia a fila no ticker (room.go:1477-1500). As entradas atrasadas chegam em fronteiras de tempo compatíveis com esse ticker, enquanto as notificações WebSocket da aplicação já foram recebidas.

A grade da chamada usa `useVoiceStore.participants`, derivada de `Room.remoteParticipants`, e aguarda o evento LiveKit. A aplicação já conhece a presença via `voiceUsers`, mas não usa essa confirmação como participante provisório da grade. A lista lateral do canal conectado também prefere participantes LiveKit. Isso faz a demora do sinal de mídia virar demora visual de presença.

Fonte primária da mesma versão executada: https://github.com/livekit/livekit/blob/v1.9.11/pkg/rtc/room.go#L51

## Correção indicada

Exibir imediatamente a presença confirmada pelo WebSocket como participante provisório, sem tracks de mídia, reconciliando pela identidade/usuário quando o LiveKit confirmar. Manter as ações que exigem track aguardando a conexão de mídia. Validar entrada, saída, conexão falha, reentrada rápida, troca de canal e participantes de instâncias federadas. Outra opção é corrigir o broadcast de transição de estado no servidor LiveKit, mas isso exige manter uma alteração do servidor; não se deve reduzir todos os lotes indiscriminadamente nem publicar mídia artificial apenas para contornar a espera.

## Limites e rastreamento

A rodada inicial incluiu um caso isolado de store para DOM de aproximadamente 1,07 s. Esse desvio não se repetiu nas seis entradas com baseline totalmente limpo, em que a inserção levou 3–6 ms após a store. A causa principal da espera de quase 3 s ficou localizada antes do callback `client.onParticipantUpdate` do SDK.

Arquivos: `join-presence-latency.json`, `join-presence-latency-settled.json`, `join-presence-summary.json`. Os scripts de medição não alteraram o produto. A tentativa de instrumentar Room.prototype.connect não capturou chamadas porque a versão instalada define connect por instância; os resultados não usam esse marcador. Os tempos de envio/recepção WS, token, callback SDK, store e DOM foram efetivamente capturados.

## Correção implementada e validada

O updateParticipants agora inclui a presença confirmada da sala de espaço atual enquanto o LiveKit ainda não anunciou o participante. O placeholder não cria tracks nem anuncia câmera/tela; o participante SDK real prevalece pelo userId. O fallback só vale para a sala exata conectada, não para DMs ou outro canal. A saída WS remove o placeholder.

| Entrando | Rodada | WS (ms) | DOM (ms) | SDK (ms) | Linhas/tiles após SDK |
| --- | --- | --- | --- | --- | --- |
| bob | 0 | 154 | 166 | 2422 | 1/1 |
| bob | 1 | 234 | 246 | 2907 | 1/1 |
| bob | 2 | 204 | 217 | 3002 | 1/1 |
| alice | 0 | 223 | 97 | 92 | 1/1 |
| alice | 1 | 118 | 133 | 2920 | 1/1 |
| alice | 2 | 172 | 182 | 2582 | 1/1 |

Seis entradas reais: mediana de DOM 174ms, máximo 246ms. O SDK continuou chegando até3002ms depois do clique, mas já não impediu a presença visual. Todas as reconciliações terminaram com uma linha e um tile, sem duplicação.

Regressões automatizadas após o patch: nove arquivos relacionados de useLiveKit, VoiceGrid, VoiceChannel e SoundController, 115 testes aprovados. Incluem seis novos testes de presença: fallback antesSDK, reconciliação com mídia real, remoção WS, exclusão de outros canais/DMs, disconnect e mudança de sessão/canal. ESLint dos arquivos alterados passou com a flag de supressões globais não podadas na execução parcial.
