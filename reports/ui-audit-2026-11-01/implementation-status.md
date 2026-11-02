# Estado das correções

Atualizado em 2026-11-01. Implementação presente no worktree; validação ao vivo após as mudanças ainda pendente.

- Popover da transmissão: altura limitada ao viewport, controles roláveis e ação de parar preservada.
- Troca de fonte: preparação sem interromper a publicação atual, configuração como rascunho, commit por replaceTrack e rollback em falhas. Fila de captura e bloqueio de confirmação evitam confirmar uma fonte anterior durante cliques rápidos.
- Qualidade: debounce de 150 ms para codec, fila compartilhada de atualizações, superfície de vídeo persistente e snapshot antes do detach anunciado pelo LiveKit.
- FPS: canvas com cadência mutável e requestFrame; alteração sem recaptura intencional da tela. Falta medir os frames reais no Electron.
- Fontes nativas: scan em andamento compartilhado, miniaturas preservadas em atualizações só de metadados e invalidação por geração.
- Modais: corrigida também a precedência de menus já abertos com mesmo z-index; camada de foco, inert no fundo, Escape apenas no topo e retorno de foco; integrada aos diálogos comuns e superfícies personalizadas auditadas.

## Verificação

- Primeiro conjunto web: 122 testes focados passaram, incluindo duas novas corridas de substituição (SDK troca track antes de rejeitar e parada durante replace pendente).
- Primeiro conjunto desktop: 16 testes focados de cache/política passaram.
- Typecheck web e build TypeScript desktop passaram.
- git diff --check passou.
- ESLint passou nos arquivos web alterados e módulos novos de cache desktop (com --pass-on-unpruned-suppressions para a execução parcial). O arquivo desktop main.ts possui cinco imports require preexistentes apontados pela regra no-require-imports; eles não foram alterados nesta correção.

## Pendência de execução

As duas sessões Electron foram fechadas via CDP para recarregar o processo principal. A camada de execução da ferramenta recusou o comando de reabertura (blocked by policy), antes de iniciar o processo. A validação ao vivo das correções e a restauração das duas janelas não foram concluídas. Perfis e dados de login permanecem nos diretórios originais. Não há medição pós-correção que comprove melhora de latência ou cadência real; os números da auditoria inicial não devem ser apresentados como resultados das correções.

API 3005, Vite 5175 e LiveKit 7880 continuavam escutando ao concluir as verificações de código.

## Revisão posterior

- Corrigida a invalidação do scan nativo também em `lastScreenSources` e no timestamp: uma enumeração antiga não repovoa o estado depois da limpeza. Desktop: 19 testes de cache/política passaram; build TypeScript passou.
- Coberta a corrida entre pedidos de metadados e miniaturas. Se ainda não havia pixels em cache, um pedido completo que compartilha um scan de metadados pode responder sem imagens; o seletor mantém a solicitação de miniaturas e repete no próximo poll (2 s, respeitando o TTL nativo de 1 s). Isso evita duplicar o scan em andamento; não implica miniaturas instantâneas na primeira captura.
- Corrigida a parada durante publicação do novo áudio na troca de fonte: a configuração não é confirmada e os recursos novos são encerrados. `screenShare.test.ts`: 17 testes passaram.
- Corrigida a parada durante anúncio/retirada de publicação na troca de codec: a intenção de parar é registrada antes das esperas e o swap não republica depois dela. `screenShare.stopPaths.test.ts`: 10 testes passaram.

A ausência das portas CDP 9223/9224 foi confirmada nesta revisão. A validação Electron continua pendente e não foi substituída por outra execução de navegador.

## Consolidação final desta revisão

- Anúncios de codec agora têm revisão monotônica. Anúncio expirado sem remoção limpa o indicador sem encerrar a transmissão; anúncios consecutivos durante a ponte capturam o quadro da publicação seguinte. O snapshot atual também limpa o marcador da ponte anterior, permitindo remover o overlay quando um segundo anúncio expira sem outra remoção.
- Uma geração de transmissão invalida operações antigas depois de parar, mesmo se uma nova transmissão já tiver tornado `isScreenSharing` verdadeiro novamente. A parada explícita prevalece sobre o marcador interno de republicação.
- Última rodada web: `screenShare.test.ts`, `screenShare.stopPaths.test.ts`, `useLiveKit.streamRepublish.test.ts` e `StreamTile.test.tsx`: 70 testes passaram. Esses testes verificam estado, posse de tracks e DOM em ambiente simulado; não comprovam frames reais de vídeo nem latência nativa.
- Typecheck web, lint dos arquivos desta revisão e diff-check passaram. Cache/política desktop: 19 testes e build TypeScript passaram.

| Critério do plano | Evidência atual | Verificação ainda necessária |
| --- | --- | --- |
| Popover utilizável em 1280x500 | Limite de altura, scroll interno e footer sem encolher no código | Renderização e hit-test no Electron mínimo/fullscreen |
| Foco, Tab e Escape só na camada superior | Testes de Modal, modais personalizados e menu anterior com mesmo z-index | Exercício real em janela principal e janela de chamada |
| Cancelar/trocar preserva publicação anterior | Testes de draft, commit, rollback e parada durante awaits | Recepção contínua por Bob durante cancelar e confirmar |
| Rajadas de codec aplicam última seleção sem fila crescente | Debounce de 150 ms, fila compartilhada, teste das pontes consecutivas e invalidação após parar | Rajadas reais de 30–100 ms, contagem de negociações e ausência de gaps visuais |
| FPS mutável sem recaptura | FrameCadence e integração do canvas com requestFrame | Cadência medida no preview e no receptor em 30/45/60 fps |
| Enumeração compartilhada e cache preservado | Testes de concorrência, metadados, thumbnails e invalidação tardia | Dez aberturas/cinco rajadas no Electron, separando scan fresco e cache |
| Ambiente com duas sessões autenticadas | Perfis preservados e serviços de suporte em execução | Reabrir Electron: comando bloqueado pela política de execução da ferramenta |

O objetivo permanece incompleto enquanto as verificações da última coluna não forem executadas. Não foi feito commit, push ou publicação.

## Diagnóstico da recusa de abertura

A sessão registrada usa approval_policy=never, sandbox danger-full-access e permission_profile disabled desde 21:40 UTC; a primeira recusa registrada no daemon ocorre às 23:24:53 UTC. O daemon retorna CreateProcess Rejected / blocked by policy antes de executar o PowerShell. As regras locais em ~/.codex/rules/default.rules contêm apenas entradas allow; não foi encontrada regra local forbidden para Electron ou Start-Process. Os logs consultados não expõem a regra que originou a recusa. Não há evidência para atribuir o bloqueio a antivírus ou erro de inicialização da aplicação. A atribuição anterior a Auto-review foi imprecisa: segundo a documentação oficial, Auto-review não atua com approval_policy=never. Nenhuma política foi alterada e nenhum contorno foi executado.

## Validação ao vivo posterior e presença

Os clientes foram reabertos pelo usuário e a validação Electron foi executada. O bloqueio de abertura não impediu esta rodada. Resultados e achados restantes em [validation-results.md](validation-results.md). A demora de presença foi corrigida no frontend e validada nas duas direções: entrada97–246ms e saída10–15ms para inserção/remoção do DOM, sem esperar o lote de até3s do SDK. Regressões finais:125 testes relacionados aprovados, typecheck e lint. A geometria compartilhada de previews, o menu na janela de chamada e picos intermitentes de mídia/enumeração continuam documentados como pendências distintas.
