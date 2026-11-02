# Auditoria de UI/UX — Electron — 1 de novembro de 2026

Foram encontrados problemas reproduzíveis no compartilhamento de tela, na acessibilidade dos modais e no alcance de controles em janelas pequenas. O trabalho desta entrega é a auditoria e o plano de melhoria; as correções do produto continuam pendentes.

## Cobertura e método

A auditoria principal usou a sessão de Alice, pelo CDP na porta 9223. Bob, na porta 9224, foi usado para conferir a recepção da transmissão. Foram executadas 1.097 amostras de navegação e abertura de painéis: 32 superfícies no ambiente de desenvolvimento, 15 rodadas na compilação de produção, 14 casos complementares e os formulários de autenticação. Existem repetições entre ambientes; esses números não significam 61 telas diferentes. Os popovers, confirmações e testes rápidos adicionais estão na [matriz de cobertura](coverage.md).

Os painéis principais tiveram uma abertura inicial e 20 repetições. Os 14 casos complementares tiveram cinco amostras. As verificações adicionais de menus, cadastro completo e chamada recebida são inspeções funcionais, sem p95 representativo.

As ações principais foram abertas pelo estado real da aplicação para isolar o custo de renderização. Entradas de navegação, menus, abas administrativas, confirmações e compartilhamento também foram acionados com eventos de ponteiro pelo CDP. Foi utilizado `elementFromPoint` para verificar se o centro do controle recebia o clique.

**Interpretação dos números:** `twoFrameMs` mede até dois frames após a ação. É um indicador instrumental, não INP nem garantia de que todos os dados chegaram. `domQuietObservationP95Ms` usa uma janela de observação mínima de 350 ms e não deve ser tratado como tempo de carregamento. Para transmissão foram medidos separadamente o aparecimento das fontes e a disponibilidade de vídeo no preview. O p95 com dez amostras coincide com o máximo pelo método de posição mais próxima; são medições exploratórias desta máquina.

A compilação de produção foi gerada com otimização de produção e uma entrada adicional que expõe os mesmos stores à auditoria. Essa instrumentação pode alterar a divisão dos chunks; seus números de startup não substituem um benchmark da distribuição oficial. A API de teste administrativo e seu banco foram isolados nas portas 3006/5180. O runtime do servidor isolado reproduziu o uso de Electron em modo Node observado no servidor existente.

Resultados estruturados: [JSON](measurements.json) e [CSV](measurements.csv). Evidências detalhadas e logs locais permanecem em `tests/.tmp/ui-audit/`.

## Resultados medidos

| Operação | Amostras | Mediana | p95 |
|---|---:|---:|---:|
| Fontes disponíveis após abrir o seletor | 10 | 516 ms | 723 ms |
| Preview com vídeo disponível | 10 | 799 ms | 989 ms |
| Enumeração nativa com miniaturas | 10 | 462 ms | 2.660 ms |
| Enumeração nativa sem miniaturas | 10 | 424 ms | 2.270 ms |
| Observação após cancelar captura | 10 | 108 ms | 120 ms |
| Requisições de API monitoradas na amostra principal | 490 | 5,0 ms | 9,4 ms |

A observação após cancelar inclui uma espera deliberada de 100 ms; o encerramento pode ter ocorrido antes. Nas 490 requisições de API dessa amostra não houve falhas HTTP registradas. Isso não é uma afirmação sobre todas as requisições da aplicação.

Os indicadores de resposta visual dos painéis ficaram geralmente na ordem de poucos frames. A primeira entrada administrativa em Geral levou aproximadamente 250 ms no indicador instrumental; as reaberturas foram menores. Não foram registradas tarefas longas de renderer nas amostras principais. Os intervalos altos de silêncio do DOM no ambiente de desenvolvimento não foram classificados como carregamento lento, porque não demonstram indisponibilidade do conteúdo e não se repetiram da mesma maneira em produção.

O receptor exibiu vídeo contínuo antes das rajadas: em uma janela de aproximadamente três segundos, o tempo avançou de 2,079 para 5,088 s e os quadros renderizados de 92 para 220, sem aumento de quadros descartados nesse intervalo.

## Problemas reproduzidos

### F01 — P1: controles da transmissão ficam inacessíveis na altura mínima

**Reprodução:** iniciar transmissão, abrir “Opções de compartilhamento de tela” e reduzir o viewport para 1280×500. O Electron permite altura mínima de 500 px.

“Áudio do sistema” ficou entre y=497,5 e y=521,5; seu centro ficou fora do viewport. “Parar de compartilhar” ficou entre y=578,5 e y=614. Documento, body e painel usavam `overflow: hidden`; não havia rolagem para alcançar esses controles.

Evidência: [captura da janela de 500 px](evidence/live-popover-500px.png). Coordenadas estão em `screenShare.minimumWindow` no JSON. Origem: `ScreenShareSettingsPopover.tsx` e o posicionamento em `useFloatingPosition.ts`.

### F02 — P1: trocar a fonte encerra a transmissão antes da escolha

**Reprodução:** transmitir → menu do vídeo → “Trocar transmissão” → “Cancelar”. A transmissão passa a desligada ao abrir o seletor e continua desligada ao cancelar.

O comportamento foi confirmado em execução e corresponde a `changeScreenShare()` em `packages/web/src/utils/screenShare.ts`, que chama `stopScreenShare(room)` antes de abrir a seleção. Não há continuidade ou recuperação da fonte anterior ao cancelar.

### F03 — P1: rajadas de codec retiram temporariamente o vídeo do receptor

Foram acionadas rajadas de resolução, FPS, codec e modo de conteúdo com aproximadamente 40 ms de espera entre comandos, além do custo de despacho. Durante a alternância H264/VP9, o monitor do receptor registrou três intervalos sem elemento `<video>`: 319, 327 e 215 ms. A amostragem foi aproximadamente a cada 100 ms; esses valores são estimativas discretas.

Isso comprova retirada temporária do elemento, não que toda a superfície tenha ficado preta: o componente pode mostrar um fallback. A reprodução voltou a avançar. A atualização já possui uma fila e cancelamento de trabalhos superados em `useLiveKit.ts`; a melhoria deve aproveitar essa infraestrutura, não criar uma segunda fila concorrente.

### F04 — P1: enumeração de fontes tem picos de segundos

A enumeração nativa custou aproximadamente 0,4–0,5 s normalmente, com picos de 2,3–2,7 s, inclusive sem miniaturas. Desativar miniaturas, isoladamente, não eliminou o custo.

No handler `get-screen-sources` em `packages/desktop/src/main.ts`, o instante do último scan só é atualizado depois do `await`. Não existe compartilhamento explícito da mesma promessa entre chamadas simultâneas de diferentes aberturas. O guard de requisição em andamento no renderer é local ao efeito de cada abertura. Isso justifica instrumentar e consolidar scans concorrentes; a duração exata de cada operação nativa ainda precisa de profiling no processo principal.

### F05 — P2: o cache pode entregar fontes sem as miniaturas solicitadas

**Reprodução pela mesma API do seletor:** pedir metadados sem miniaturas e, imediatamente depois, pedir fontes com miniaturas dentro do intervalo de cache. Foram devolvidas oito fontes e zero miniaturas; a resposta em cache levou 0,3 ms.

`lastServedScreenSources` é substituído pela serialização sem miniaturas. Uma abertura nova começa com `sources=[]`, portanto não possui as imagens da abertura anterior para combinar com esses metadados. A evidência prova a resposta incompleta do cache; a duração visual até o próximo refresh completo não foi medida.

### F06 — P2: FPS do preview de janela não acompanha a opção selecionada

**Reprodução:** selecionar uma janela com captura a 60 FPS e mudar para 45 FPS no drawer. A opção selecionada passou a 45, mas o track existente continuou em 60. Foi confirmado que o track tinha `setDestination`, portanto era o caminho de captura por canvas. Uma nova seleção da fonte passou a produzir o track com o FPS escolhido.

`applyStagedCaptureConfig()` redimensiona esse canvas, mas não atualiza seu controlador de cadência. `windowCropCapture.ts` cria a saída com `canvas.captureStream(options.frameRate)`. O achado diz respeito ao preview existente; não comprova envio remoto acima do limite configurado.

### F07 — P1: o foco sai dos modais e Escape fecha mais de uma camada

Ao abrir Configurações com clique real, o foco permaneceu no botão da página de fundo. O primeiro Tab alcançou “Configurações de notificação” atrás do modal. Nessa superfície não havia `role="dialog"`/`aria-modal` nem contenção de foco.

Ao abrir “Excluir conta” e pressionar Escape, as configurações também fecharam. As confirmações de exclusão de canal e categoria, por outro lado, fecharam apenas a confirmação e mantiveram a configuração aberta. Essas diferenças foram registradas em `tests/.tmp/ui-audit/interactions.json`.

## Plano de correção, em ordem

### 1. Corrigir alcance e interação das superfícies flutuantes

- Dar ao popover de transmissão altura máxima baseada nas unidades de viewport e no inset da barra de título já usados pelo projeto.
- Usar estrutura flexível com cabeçalho e ação de parar sempre alcançáveis; o corpo dos controles deve ter `min-height: 0` e rolagem vertical.
- Manter o cálculo de posicionamento compatível com zoom da interface, documento da janela e fullscreen.
- Centralizar o registro das camadas modais por documento: foco inicial, contenção de Tab, retorno de foco e Escape apenas na camada superior. Migrar também os diálogos personalizados que hoje escapam da infraestrutura comum.
- Preservar a proteção já existente das cópias de animação de saída: `inert`, `aria-hidden` e ausência de eventos de ponteiro.

**Aceitação:** em 940×500, 1280×500 e 1280×800, todos os controles podem ser alcançados por mouse ou rolagem; parar a transmissão continua disponível. Repetir com escalas de interface de 100%, 125%, 150% e 200%. Tab não alcança o fundo e Escape fecha só a camada superior, inclusive em sequências rápidas de abertura/fechamento.

### 2. Tornar a troca de fonte uma operação com confirmação

- Acrescentar um modo interno `start | replace` ao estado de configuração da transmissão.
- No modo de troca, manter a publicação atual enquanto a nova captura é preparada. Manter a configuração em rascunho local, para que escolher qualidade no seletor não altere a transmissão antiga.
- Permitir que `StreamQualityControls` receba valor e callback controlados pelo rascunho; conservar o comportamento atual para o popover da transmissão ativa.
- Passar a configuração da captura explicitamente às funções de staging, em vez de depender apenas do estado global.
- Confirmar a troca usando `LocalTrack.replaceTrack`, disponível na versão instalada do LiveKit, preservando a publicação quando o codec for compatível. Tratar mudança de codec pela atualização serializada existente.
- Só encerrar os recursos anteriores depois do sucesso. Cancelamento ou falha encerram a nova captura e preservam a antiga.

**Aceitação:** cancelar não interrompe o receptor; falha ao preparar a nova fonte mantém a antiga; após confirmar, não sobram tracks antigas. Durante a preparação de substituição, duas capturas podem existir deliberadamente; após cancelar ou confirmar, apenas a captura apropriada permanece.

### 3. Consolidar atualizações rápidas de qualidade

- Aplicar feedback visual imediatamente e consolidar mudanças de codec com debounce de 150 ms antes de negociar.
- Aproveitar `_activeTrackUpdate` e o mecanismo de trabalhos superados existentes. Revalidar geração e configuração desejada depois de cada espera relevante e imediatamente antes de republicar.
- Preservar a identidade visual da transmissão no receptor durante a republicação, usando o último quadro/fallback estável até a nova publicação estar pronta, em vez de desmontar toda a apresentação.
- Dar ao controlador do canvas uma cadência mutável. Atualizar destino e FPS no preview sem iniciar outra captura de tela; uma opção é captura manual de quadros com agendamento limitado pelo FPS escolhido.
- Validar codec e FPS pelos dados reais de WebRTC e cadência dos quadros; não usar apenas o texto da seleção ou `getSettings()` como prova final.

**Aceitação:** em rajadas de 30–100 ms, a última seleção vence; não há fila crescente de renegociações; uma rajada termina com no máximo uma negociação necessária para o codec final. O receptor mantém a superfície visual e retoma vídeo sem intervenção. O preview animado acompanha a cadência escolhida sem recaptura desnecessária.

### 4. Consolidar enumeração e corrigir o cache de fontes

- Compartilhar uma promessa de enumeração por janela autorizada, inclusive entre aberturas rápidas, mantendo as verificações de origem, foco e intervalo de captura.
- Separar cache de metadados e cache de miniaturas. Um refresh sem imagens não deve apagar miniaturas ainda válidas das mesmas fontes.
- Exibir imediatamente o cache permitido pela política e atualizar de forma assíncrona. Uma resposta só de metadados deve ser distinguível de uma resposta com imagens, para que o renderer não considere o pedido visual concluído.
- Manter a proteção por geração para ignorar resultados de aberturas canceladas; não tentar simular cancelamento de uma operação nativa que não oferece cancelamento real.
- Medir separadamente `desktopCapturer.getSources`, obtenção de ícones, serialização e consulta de geometria antes de decidir substituir alguma operação nativa.

**Aceitação:** a sequência metadados → pedido com miniaturas não apaga as imagens do cache; chamadas simultâneas não multiplicam scans; cancelar continua responsivo durante um scan lento; não há enumeração nova em segundo plano que viole a política atual. Comparar dez aberturas e cinco rajadas com a amostra desta auditoria, separando cache de scan fresco.

### 5. Repetir a auditoria depois de cada mudança

Reexecutar primeiro o caso que motivou a correção, depois os cenários relacionados. Manter os testes rápidos de fonte, codec e cancelar/reabrir, além de viewport mínimo, fullscreen, janela de chamada separada e teclado. Acrescentar testes de regressão com invariantes de estado e recursos: última seleção, posse dos tracks, retorno de foco e continuidade da publicação.

Não há evidência nesta amostra para priorizar uma reescrita geral de listas ou da camada de API. Conversas extensas e espaços com centenas de membros devem receber uma rodada de carga própria antes de propor virtualização ou mudanças amplas de cache.

## Limites e estado final

A [matriz](coverage.md) identifica os estados exercitados e as pré-condições ausentes. Esta auditoria não é certificação de todas as combinações de hardware, permissões, redes e volumes de dados. Os dados principais são pequenos: espaço controlado, DMs de teste e grupo de três pessoas.

Não foram confirmadas ações destrutivas de conta, canal, categoria, pacote ou propriedade; suas superfícies de confirmação foram inspecionadas. Publicação em diretório externo e envio de telemetria não foram ativados. O seletor de GIF não foi exibido na configuração disponível, e fluxos dependentes de pares federados reais ficaram pendentes.

As transmissões de teste foram encerradas. Alice voltou a `http://localhost:5175/channels/@me`, autenticada e fora de voz/transmissão. Bob permaneceu autenticado na outra sessão. O espaço privado `UI Audit — disposable` permanece disponível no ambiente local; os dados administrativos ficam no banco temporário da auditoria.

Os processos exclusivos do servidor e preview administrativos foram encerrados ao final. Os arquivos de evidência e o banco temporário foram preservados. Os scripts da auditoria passaram pela verificação de sintaxe do Node; a validação funcional está documentada nas medições e capturas, não em testes unitários do produto.

## Reprodução e artefatos

- `scripts/run-ui-audit.mjs`: rodadas de painéis e páginas; `AUDIT_REPETITIONS`, `AUDIT_FILTER`, `AUDIT_OUTPUT` e `AUDIT_RESUME` controlam a execução.
- `scripts/ui-audit-production.mjs`: prepara compilação instrumentada, servidor isolado e primeira conta administrativa. A criação inicial pressupõe banco temporário novo; não deve ser repetida indiscriminadamente sobre um banco já usado.
- `scripts/ui-audit-rapid-share.mjs`: rajadas com seletor/drawer previamente aberto; `AUDIT_RAPID_MODE=live` mede o popover ativo.
- `scripts/ui-audit-share-timings.mjs` e `scripts/ui-audit-video-sample.mjs`: disponibilidade do preview e observação do receptor.
- `scripts/ui-audit-interactions.mjs`, `ui-audit-extras.mjs`, `ui-audit-contexts.mjs`, `ui-audit-auth.mjs` e `ui-audit-call.mjs`: cobertura funcional complementar.
- `scripts/ui-audit-report.mjs`: gera os resumos JSON e CSV a partir dos resultados locais.

Os scripts atuam sobre dados e sessões reais do ambiente de teste. Para repetir medições, usar fixtures descartáveis e evitar interação manual concorrente na janela auditada. O controle do receptor deve ficar restrito ao teste entre usuários, como nesta execução.

## Acompanhamento das correções

O estado da implementação, testes e limitações da validação posterior está em [implementation-status.md](implementation-status.md). As medições anteriores deste relatório continuam sendo a linha de base, não evidência de resultado pós-correção.
