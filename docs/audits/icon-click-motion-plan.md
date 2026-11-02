# Plano de animações de ícones por clique

Branch: `design/icon-click-motion`, criada a partir de `Dev` (`c0bf31e6`).

## Levantamento

Varredura estática de todos os arquivos TS/TSX de produção em `packages/web/src`, excluindo testes e previews de desenvolvimento: 490 declarações de SVG em 133 arquivos. São ocorrências, não 490 desenhos únicos ou 490 controles clicáveis. Também foram examinados os pontos compartilhados ControlIcon, BookmarkIcon, AppIcon, os arquivos de marca SVG e o HTML dos avisos nativos.

Distribuição principal: layout 148, chat 99, voz 77, modais 80 e componentes UI 54; demais ocorrências em autenticação, notificações, telemetria, entrada e hub. O AppIcon reúne marcas de jogos/serviços, enquanto grande parte dos controles usa SVG inline duplicado. Há feedback de pressão isolado em controles mobile; não existe um padrão geral para ícones.

Isso cobre o inventário do código; não significa que cada ocorrência tenha sido acionada manualmente em todos os estados.

## Linguagem proposta

| Família | Movimento ao clicar |
|---|---|
| Navegação, servidores, abas | Pressão breve e retorno suave, sem mover o texto ou o cartão. |
| Engrenagem e configurações | Giro curto de 30–45 graus e retorno. |
| Sino | Duas oscilações discretas, sem tremor contínuo. |
| Microfone, áudio e câmera | Pressão curta; traço/estado muda junto da ação real. |
| Compartilhar tela e fullscreen | Expansão/retração de 4–6%, contida dentro da área do ícone. |
| Enviar, anexar e baixar | Deslocamento direcional de 1–2px e retorno. |
| Favoritar, salvar e reações de controle | Pulso único discreto; preenchimento depende do estado real. |
| Check, adicionar e aceitar | Pulso curto; confirmação apenas depois de sucesso quando houver requisição. |
| Fechar, recusar e remover | Pressão simples, sem efeitos festivos ou sacudida de erro. |
| Setas, menus e submenus | Rotação curta coerente com aberto/fechado; retorno ao fechar. |
| Controles de mídia | Pressão breve e transição visual entre play/pause conforme o estado. |
| Marcas e avatares clicáveis | Pressão discreta do símbolo inteiro, sem deformar o desenho. |

Ícones decorativos, presença e marcas apenas informativas permanecem estáticos. Os controles que os contêm recebem feedback se forem clicáveis. Emojis do conteúdo e efeitos MSN mantêm seu comportamento próprio.

## Regras técnicas

- Duração usual 140–240ms, pressão inicial 70–100ms, sem loops.
- Animar transform/opacity do ícone, preservando tamanho, posição, foco, hitbox e geometria do menu.
- Usar CSS/WAAPI, sem biblioteca adicional. Cancelar/substituir uma animação anterior em cliques repetidos; não acumular filas ou timers.
- Ativação pelo clique semântico: mouse, toque e ativação por teclado. Arrastar ou cancelar um toque não deve disparar confirmação.
- Desabilitados não animam. Requisições em andamento não parecem concluídas antecipadamente.
- Nunca atrasar navegação, envio, fechamento, mídia ou entrada em chamada para esperar a animação. Se o controle desaparecer, a ação tem prioridade.
- Respeitar prefers-reduced-motion explicitamente também no caminho WAAPI; o CSS global sozinho não cancela esse tipo de animação.
- Aplicar famílias por marcadores explícitos nos controles; evitar um seletor global que anime todo SVG indiscriminadamente.
- Reutilizar o contrato nos avisos nativos e nas janelas destacadas.

## Execução sugerida

1. Criar primitivas e tokens de duração, curva e intensidade.
2. Migrar navegação, chat e configurações, incluindo variantes mobile.
3. Migrar voz, vídeo, transmissão, popovers e menus.
4. Cobrir ações de amizade, notificações nativas, telemetria e hub.
5. Revisar todas as ocorrências do inventário: interativa, decorativa ou marca; registrar cobertura e exceções.
6. Validar clique rápido/repetido, teclado, toque, disabled/busy, modo de movimento reduzido, fullscreen e escala da interface.

## Implementação e validação

Implementado na branch `design/icon-click-motion`, a partir de `Dev` (`c0bf31e6`).

O mecanismo usa um listener delegado por documento e marcadores explícitos nos controles. Somente o símbolo recebe WAAPI; navegação, envio e fechamento seguem imediatamente. As famílias usam propriedades individuais de transformação para preservar transformações existentes. Repetir o clique cancela a animação anterior. Desmontar o mecanismo cancela animações e remove listeners. Movimento reduzido cancela efeitos ativos e impede novos.

Cobertura: navegação desktop/mobile, chat e anexos, amizade, configurações do usuário/servidor/instância, menus e submenus, voz/vídeo/transmissão, hub, telemetria, notificações web e nativas e janela de chamada destacada. Ícones produzidos com React.createElement são alcançados pelo controle pai. Avatar e AppIcon compartilham o mecanismo. Os marcadores em controles sem ícones não produzem animação. Ícones informativos, spinners, imagens grandes e conteúdo decorativo permanecem estáticos.

As setas recebem um movimento breve; estados aberto/fechado e play/pause continuam sendo renderizados pelos componentes existentes. Não há espera artificial para manter um ícone visível após uma ação que o remove.

| Área | Controles com marcador literal |
|---|---:|

| FriendRequestNotifications.tsx | 4 |
| JoinPage.tsx | 17 |
| auth | 10 |
| bookmarks | 3 |
| chat | 156 |
| layout | 130 |
| modals | 373 |
| notifications | 4 |
| projectHub | 14 |
| telemetry | 6 |
| ui | 54 |
| voice | 88 |

Além desses marcadores, Avatar aplica o marcador condicionalmente quando possui onClick; Button fornece o padrão para consumidores.

Validação: 40 testes web de comportamento/regressão e 3 testes desktop passaram; typecheck web e build TypeScript desktop passaram. Build de produção web passou. No Electron aberto: engrenagem com 220ms, nenhuma animação no botão, geometria preservada, 30 cliques com apenas uma animação ativa; toque via CDP disparou o efeito; após a alteração de preferência ser aplicada, movimento reduzido resultou em zero animações. Sem exceções de runtime observadas nesses ensaios. A ativação semântica por click também está coberta nos testes. A ativação por Espaço via CDP, com o cliente em primeiro plano, também resultou em uma animação; o envio de Enter no primeiro ensaio não gerou feedback. As notificações nativas foram compiladas e testadas, mas precisam de reinicialização do Electron para validação visual.
