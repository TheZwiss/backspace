# Desconexão da chamada: antes e depois

Seis saídas em cada rodada, três de Alice e três de Bob, com microfones silenciados e aguardando a entrada SDK antes de sair.

| Saindo | Rodada | DOM antes (ms) | DOM depois (ms) | SDK depois (ms) | Linhas/tiles após aviso SDK |
| --- | --- | --- | --- | --- | --- |
| bob | 0 | 247 | 12 | 2012 | 0/0 |
| bob | 1 | 2332 | 10 | 474 | 0/0 |
| bob | 2 | 2366 | 11 | 2395 | 0/0 |
| alice | 0 | 1576 | 14 | 1091 | 0/0 |
| alice | 1 | 2363 | 13 | 2351 | 0/0 |
| alice | 2 | 2542 | 15 | 2346 | 0/0 |

A interface agora respeita a saída confirmada pelo WebSocket em vez de manter o participante até o evento atrasado do SDK. `departedVoiceUserIds` guarda somente as saídas do canal atual; novas entradas/snapshots confirmados removem o marcador, e mudança de canal ou encerramento da sessão o limpa. Apenas os participantes remotos desse canal são filtrados; uma ausência genérica do roster não exclui participantes SDK e DMs não usam esse filtro.

Isso reduz a demora visual para sumir do outro cliente. Não altera o intervalo de sinalização do servidor LiveKit nem prova que o transporte de mídia inteiro foi fechado em10–15ms. O teste foi feito com microfones silenciados.

As notificações SDK tardias foram aguardadas; a pessoa não reapareceu. Dois ciclos reais de sair/reentrar em70ms também terminaram com uma linha, sem duplicação e sem perder a nova presença após eventos antigos. Evidência: `quick-reentry-after-fix.json`.

Regressões após o patch: 125 testes relacionados aprovados em10 arquivos (presença, captura, reconexão, retomada de streams, republicação, grade, lista lateral e sons). Typecheck web e ESLint dos arquivos alterados aprovados. Evidência de vídeo real após o patch: `presence-fix-media-smoke.json` mostra o mesmo track remoto avançando de52 para137 frames e de0,931 para2,449s.
