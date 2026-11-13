# Entrega — padronização visual do Backspace

Branch: `audit/ui-visual-consistency`, baseada em `Dev` (`5235d863`).

Implementação dos 18 pontos da auditoria de 2026-11-02, preservando a estrutura e identidade do app.

| Ponto | Implementação |
|---|---|
| 01 Foco | Removida a supressão global de outline; foco compartilhado para teclado, sem duplicar o anel dos campos. |
| 02 Contraste pastel | Foreground escuro nas ações rosa/amarelas claras e variantes danger/warning compartilhadas. |
| 03 Primário | Roxo de ação ajustado; testes de contraste nos estados normal, hover e pressionado. |
| 04 Texto auxiliar | Tokens tertiary/category mais legíveis; preservados disabled e decoração. |
| 05 Botões | Classes ui-button e componente Button; 96 ações migradas inicialmente, mais confirmações e aviso de amizade. |
| 06 Interação | Hover usa primary-hover; variante primária possui primary-active, disabled e foco compartilhados. |
| 07 Tipografia | Papéis text-ui-title/lead/message/body/label/caption/micro; consolidação de medidas fracionadas e legendas pequenas. |
| 08 Configurações | Settings-section compartilhada em Conta, Privacidade, Voz e Notificações. |
| 09 Amizade | Superfície fosca, sem gradiente/sombra colorida; Button primário para adicionar/aceitar e secundário para cancelar/recusar. |
| 10 Modais | Superfície e título compartilhados, mantendo larguras especiais e folhas mobile. |
| 11 Seletores | ui-select compartilhado, foco e seta comuns; seleção nativa preservada no mobile. |
| 12 Sliders | ui-range com estilos WebKit/Firefox, foco e alvos mobile maiores. |
| 13 Toque | Área mínima de 44 × 44 nos botões mobile; track do switch permanece compacto. |
| 14 Tooltips | 91 controles migrados inicialmente; hover e foco usam tooltip do app, largura limitada, associação aria-describedby e Escape. Wrapper sem caixa preserva a geometria dos controles. |
| 15 Camadas | Tokens para modal/menu/tooltip/confirmação/toast/atenção/fullscreen; classes disponíveis também no JIT do ambiente de testes. |
| 16 Avisos nativos | Paleta compartilhada com o aviso interno; DM Sans incorporada com licença; labels localizadas via IPC, limitadas e escapadas no HTML. |
| 17 Escala | Fallback fullscreen e popovers usam as unidades escaladas; breakpoints de componentes alinham-se a desktop. |
| 18 Ícones | Sino e ações de transferência passaram de emoji/caracteres a SVG compartilhado. Emojis de mensagens e efeitos MSN continuam sendo conteúdo. |

## Verificação

- Build web de produção aprovado; typecheck aprovado.
- Build TypeScript do Electron aprovado; 38 testes nativos passaram, incluindo renderização da fonte e escape das labels da notificação.
- Suíte web completa: 3.783 passaram de 3.816. As 33 falhas restantes foram reproduzidas na base `Dev` em worktree separado; a comparação por nome de teste não encontrou falhas novas na rodada final.
- Falhas anteriores estão em testes de chamadas com mocks incompletos, amizade/presença, editores e camadas. A suíte não está inteiramente verde; não foram tratadas como testes aprovados nem escondidas.
- Após a migração final do banner para Button: os quatro testes do banner passaram e o typecheck foi executado novamente.
- Testes de contrato de contraste, paleta compartilhada, cores, escala, foco, tooltip e componentes centrais passaram.
- Navegação pelos controles reais em Conta, Notificações e Voz sem exceções Runtime.exceptionThrown. Modal com z-index calculado 200. Capturas locais em `tests/.tmp/ui-visual-audit/updated-*.png`.
- Emulação mobile 390 × 844: nenhum botão medido com altura inferior a 44 px. Não substitui validação em aparelhos Android/iOS reais.

## Roteiro para testar

1. No cliente aberto, recarregue se necessário. Percorra os controles com Tab: o foco deve aparecer, sem contorno preso após clique de mouse.
2. Compare Conta, Privacidade, Notificações e Voz: cartões, selects, sliders e botões devem compartilhar o acabamento.
3. Na DM com um não-amigo, verifique adicionar, pedido enviado/cancelar e recebido/aceitar/recusar. O aviso mantém destaque na ação principal e desaparece após aceitar.
4. Abra menus dentro de modais e passe o mouse nos ícones; confira nome, tooltip, Escape e ausência de tooltip nativo duplicado.
5. Em viewport mobile, confira botões, switches, teclado, campos e conteúdos longos.
6. Confira fullscreen e popovers nas escalas de interface 80%, 100% e 125%, em retrato e paisagem.
7. Para a nova aparência da notificação **nativa**, feche e abra os dois clientes. O reinício automático foi rejeitado pela revisão automática com `blocked by policy`; os processos existentes não foram encerrados pela tentativa rejeitada.

A UI web foi conferida nos clientes abertos. A nova notificação nativa foi compilada e testada com Electron mockado; sua aparência ao vivo depende dessa reabertura manual. O merge desta etapa não foi realizado.
