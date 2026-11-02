# Auditoria de consistência visual — Backspace

Data: 2026-11-02. Base: `Dev` / `5235d863`. Branch: `audit/ui-visual-consistency`.

## Escopo e limites

- Revisão estática dos 244 arquivos TSX de implementação em `packages/web/src/components`, excluindo testes, dos tokens Tailwind/CSS, do guia visual e das notificações nativas novas do Electron.
- Inspeção visual no cliente de teste: login, DM, Configurações de Conta, Notificações e Voz. Capturas em `tests/.tmp/ui-visual-audit/` (ignoradas pelo Git).
- Layout mobile inspecionado por emulação de viewport 390 × 844 no Electron. Isso não equivale a testes em Safari/Android reais.
- As demais telas foram cobertas pela análise de código, não por abertura manual de cada modal, permissão e estado. Comportamentos de sobreposição e de escala indicados abaixo ainda precisam de reprodução específica.
- Nenhuma implementação visual alterada nesta auditoria. As propostas são para revisão.

## Referência existente

O guia `docs/systems/design-system.md:10` define Aether Drift: superfícies foscas, vidro discreto, sombras mínimas e ausência de gradientes decorativos. A paleta é definida em `packages/web/src/styles/globals.css:47` e exposta por `packages/web/tailwind.config.js:12`. A identidade existente deve ser preservada.

O levantamento encontrou 769 ocorrências de `<button`, 23 de `<select`, 260 linhas com `title=` e 15 com `<Tooltip` nos arquivos de componentes. São contagens de código, não quantidades de controles simultaneamente visíveis nem provas isoladas de defeito. Foram encontrados 18 tamanhos arbitrários distintos em `text-[Npx]`, além dos tamanhos padrão do Tailwind. Variações de tamanho e forma podem ser legítimas; os problemas são as diferenças em funções equivalentes sem regra compartilhada.

## Achados

### 01 — Alta: foco de teclado globalmente suprimido

**Evidência:** `packages/web/src/styles/globals.css:109–112`: `* { ... outline: none !important; }`. Controles como `FriendsVoiceCard.tsx` e `DmFriendshipBanner.tsx` tentam usar `focus-visible:outline`. A declaração global com `!important` vence esses contornos. Inputs com `focus:ring-*` continuam sendo um caso diferente, porque o anel usa sombra.

**Efeito:** alguns campos evidenciam foco, enquanto botões, avatares e cartões podem não indicar onde o teclado está.

**Proposta:** remover a supressão universal e estabelecer um padrão compartilhado de `focus-visible` para controles. Não adicionar contornos permanentes aos cliques de mouse.

### 02 — Alta: branco sobre cores claras em ações destrutivas e de aviso

**Evidência:** `components/ui/ConfirmDialog.tsx:42–64`, `components/voice/VoiceControlBar.tsx:290`, `components/layout/MobileVoiceFullScreen.tsx:549`, `components/modals/TransferOwnershipModal.tsx:184`. Rosa e amarelo claros recebem texto/ícones brancos. Já `components/projectHub/CommunityCard.tsx:267` usa texto escuro sobre amarelo, demonstrando a divergência.

**Medição:** branco sobre `accent-rose` opaco: **1,89:1**; sobre `accent-amber`: **1,44:1**. Calculado dos canais RGB definidos no tema; estados com transparência precisam de composição sobre o fundo para cálculo próprio.

**Proposta:** distinguir cor pastel decorativa de cor de ação. Usar texto escuro em fundos pastéis ou fundos de ação mais escuros, com estados de hover/disabled coerentes.

### 03 — Alta: contraste insuficiente também no botão primário normal

**Evidência:** `styles/globals.css:71–73` define `accent-primary = 124 108 246`; `components/auth/LoginPage.tsx:132` e vários formulários aplicam branco sobre ele.

**Medição:** branco sobre a cor primária opaca: **3,94:1**, abaixo da referência de 4,5:1 para texto comum pequeno. A aparência pode parecer forte sem garantir legibilidade suficiente.

**Proposta:** ajustar o token de ação preenchida e o respectivo foreground, preservando o roxo da marca para ícones e decoração. Validar os estados antes de substituir globalmente.

### 04 — Alta: textos auxiliares apagados demais

**Evidência:** `styles/globals.css:79` e usos como `components/layout/ChannelSidebar.tsx:512,547`, `components/modals/settingsPanels/PrivacyPanel.tsx:46`. Conferido visualmente em login, navegação das configurações e histórico da DM.

**Medição:** `text-tertiary` sobre `surface-channel`: **2,62:1**; sobre `surface-base`: **2,98:1**. Valores nominais, sem opacidade adicional.

**Proposta:** reservar o nível mais apagado a decoração/desabilitados. Descrições que orientam decisões e metadados relevantes devem ter um token de texto legível. Não clarear indiscriminadamente todos os divisores e placeholders.

### 05 — Média: botões equivalentes com formas e densidades diferentes

**Evidência:** login usa `rounded` e `py-2.5` (`auth/LoginPage.tsx:132`); criar canal/categoria usa `rounded-full`, `px-3 py-1.5` (`modals/CreateChannel.tsx:175`, `CreateCategory.tsx:82`); confirmação usa `rounded-lg` (`ui/ConfirmDialog.tsx:57–64`); o aviso de amizade usa `rounded-xl` e altura mínima 44 (`chat/DmFriendshipBanner.tsx`). Não há um componente Button compartilhado na pasta `components/ui`.

**Proposta:** definir variantes primary/secondary/ghost/danger e tamanhos compact/default/touch. Manter botões circulares para ícones e documentar a exceção dos controles de chamada.

### 06 — Média: estados de interação não seguem os tokens já existentes

**Evidência:** `globals.css:72–73` possui `primary-hover` e `primary-active`, enquanto `auth/LoginPage.tsx:132` usa `hover:bg-accent-primary/80`; `chat/DmFriendshipBanner.tsx` usa `/85`. Outros controles variam entre opacidade, fundo branco translúcido e troca de cor.

**Efeito:** a mesma ação tem diferentes intensidades; hover por transparência depende do fundo.

**Proposta:** padronizar hover, pressed, disabled e busy nas variantes de botão. Cancelar pedido deve continuar secundário; aceitar/adicionar deve continuar primário.

### 07 — Média: escala tipográfica muito fragmentada

**Evidência:** `layout/ActivityPanel.tsx` combina 20, 13.5 e 10.5px; `chat/Message.tsx:728,753` usa 11.5px; `layout/SpaceSidebar.tsx:226,255` inclui 7px; `chat/AttachmentProgress.tsx:63–69` usa ícones textuais de 9px.

**Proposta:** definir papéis de título, corpo, label, legenda e badge. Avaliar as variantes muito pequenas uma a uma; miniaturas e iniciais decorativas não precisam ter o mesmo tamanho do corpo do chat.

### 08 — Média: cartões das configurações mudam de material entre abas

**Evidência:** Conta (`modals/settingsPanels/AccountPanel.tsx:425,663`) e Privacidade (`PrivacyPanel.tsx:42`) usam fundo branco translúcido de 3%, borda de 4%, raio 8 e padding 14. Notificações (`NotificationsPanel.tsx:21,36`, `NudgePreferencesSection.tsx:18`) usa `surface-elevated`, borda semântica, raio 10 e padding 16. Conferido nas capturas.

**Proposta:** criar um SettingsSection compartilhado e escolher uma superfície base. Diferenciação de material deve comunicar hierarquia, não apenas a aba que implementou o cartão.

### 09 — Média: aviso de amizade foge do princípio visual documentado

**Evidência:** `chat/DmFriendshipBanner.tsx:37` introduz gradiente decorativo; o botão usa sombra colorida. O guia pede superfícies calmas e sombras mínimas (`docs/systems/design-system.md:10–15`).

**Proposta:** preservar o destaque solicitado para adicionar/aceitar, mas usar fundo fosco, borda sutil e um único ponto de ênfase. Se esse tratamento for aprovado como nova linguagem visual, atualizar o guia e aplicá-lo a avisos equivalentes.

### 10 — Média: famílias de modal com medidas diferentes

**Evidência:** `ui/Modal.tsx` oferece casca compartilhada, título `text-xl font-bold`, largura padrão `max-w-md` e raio `rounded-lg`; `ui/ConfirmDialog.tsx:50–53` cria outra casca de 440px com título `text-lg font-semibold` e raio `rounded-xl`; `modals/UserProfileModal.tsx:249–251` e `voice/ScreenShareSetup.tsx:570–582` implementam suas próprias superfícies.

**Proposta:** unificar cabeçalho, margens, botão fechar e rodapé. Preservar tamanhos especiais para perfil e escolha de captura; diferença funcional de largura não é um defeito por si só.

### 11 — Média: selects nativos e seletores próprios sem aparência única

**Evidência:** `modals/settingsPanels/NudgePreferencesSection.tsx:13–14` usa select nativo com classes próprias; `modals/instanceSettingsPanels/GeneralPanel.tsx` usa select com `input-standard`; Voz usa seletores próprios de dispositivo. Existem 23 `<select` no conjunto analisado.

**Efeito:** setas, altura, foco e lista aberta dependem do controle e da plataforma.

**Proposta:** definir uma aparência base para campos de seleção e reservar seletores pesquisáveis para listas extensas. Manter a seleção nativa no mobile quando beneficiar usabilidade.

### 12 — Média: sliders customizados só parcialmente

**Evidência:** `NotificationsPanel.tsx:27–28` e `NudgePreferencesSection.tsx:24–27`: trilho de 6px, thumb de 12px e regras de thumb `::-webkit-slider-thumb`, sem equivalente `::-moz-range-thumb` nesses componentes.

**Proposta:** componente Range com trilho/thumb/foco compartilhados e área de interação maior que o desenho. Validar Chromium/Electron e Firefox; não foi feito teste visual em Firefox nesta auditoria.

### 13 — Alta no mobile: tamanhos de toque inconsistentes

**Evidência:** `ui/Toggle.tsx:23` tem 24px de altura; `layout/MobileChatScreen.tsx:123,172` usa controles 32×32; `chat/NudgeButton.tsx:69` usa 40×40 no mobile. Os controles principais da chamada usam 44×44 em `layout/MobileVoiceFullScreen.tsx`, e o novo banner de amizade também usa altura mínima 44.

**Confirmação em viewport emulado:** voltar/transferências de 32px e anexar/sino/emoji/figurinhas de 40px. A medição de um elemento não inclui automaticamente áreas de toque externas criadas por ancestrais; os controles citados precisam dessa revisão.

**Proposta:** padronizar área de toque confortável (alvo de projeto: 44×44), mantendo ícones menores no centro. O switch não precisa ficar visualmente gigante: a área acionável pode ser ampliada.

### 14 — Média: tooltips do navegador misturados com os do app

**Evidência:** `voice/VoiceControlBar.tsx:138–291` e os avatares de `layout/ActivityPanel.tsx` usam `title`; existe `ui/Tooltip.tsx`, com material, posicionamento e delay do app. O componente próprio não é utilizado na maioria dos casos identificados.

**Proposta:** aplicar o tooltip compartilhado onde o usuário precisa de explicação rápida. Manter `aria-label` independente. Evitar tooltip duplicado e não depender de hover para informação essencial no mobile.

### 15 — Média, risco a validar: sobreposições com z-index sem escala única

**Evidência:** `ui/Modal.tsx` usa 200; `ui/ConfirmDialog.tsx:45` usa 10000; menus desktop usam 199/200 e mobile 300/301 (`ui/ContextMenuRenderer.tsx:425,443,532,538`); notificações em `utils/inAppNudge.ts` usam 899/900.

**Efeito potencial:** confirmação, menu, tooltip e aviso podem se sobrepor de forma inesperada quando combinados. Não foi reproduzido bloqueio de clique nesta auditoria.

**Proposta:** estabelecer camadas semânticas e testar menu dentro de modal, confirmação sobre configurações, aviso durante modal e modo fullscreen. Preservar a ordenação via portal documentada.

### 16 — Média: notificações de atenção usam outra fonte e estilos duplicados

**Evidência:** `utils/inAppNudge.ts:29–45` usa `13px system-ui`, cores inline e `--txt-primary`, enquanto o tema define `--text-primary`; o fallback mascara o nome divergente. `packages/desktop/src/nudgeToast.ts:34` duplica HTML/CSS, usa system-ui e cores literais. O texto da notificação é fixo em português. O app usa DM Sans e arquivos de tradução.

**Proposta:** compartilhar os valores de design e textos localizados entre aviso interno e nativo, com fallback de fonte explícito. Não trocar o mecanismo nativo necessário para aparecer fora do app.

### 17 — Média, risco a validar: fullscreen de transmissão ignora unidades de escala

**Evidência:** `components/voice/StreamTile.tsx` aplica `width: 100dvw` e `height: 100dvh` no fallback; `styles/globals.css:42–44` define `--app-vh`, `--app-dvh` e `--app-vw` ajustados por `--interface-scale`. O guia contém uma seção específica sobre escala.

**Proposta:** alinhar o fallback às unidades já usadas pelo app e verificar 80%, 100%, 125% e orientação retrato/paisagem. Não foi reproduzido recorte por escala nesta auditoria; é uma divergência de implementação comprovada com efeito visual ainda a validar.

### 18 — Baixa/Média: ícones funcionais misturam emoji, caracteres e SVG

**Evidência:** `chat/NudgeButton.tsx:69` mostra o emoji de sino; `layout/FriendsVoiceCard.tsx` usa SVG para voz; `chat/AttachmentProgress.tsx:63–69` usa caracteres ▶/⏸/✕; várias barras de ação usam SVG com diferentes espessuras.

**Proposta:** usar um conjunto de ícones funcionais com tamanho e traço consistentes. Preservar emojis no conteúdo das mensagens, stickers e efeitos MSN, porque ali são conteúdo e não cromagem da interface.

## O que manter

- Paleta escura e identidade roxa/pastel; o problema é a aplicação e o contraste, não a existência dessas cores.
- Estrutura fosca para conteúdo e vidro discreto para controles flutuantes.
- Avatares, cores pessoais e de presença, efeitos MSN e conteúdo multimídia.
- `Modal`, `Tooltip`, `Avatar`, `Toggle`, menus centralizados e os tiers de input como pontos de consolidação.
- Diferenças intencionais entre desktop e mobile; padronizar significado e acabamento, não forçar dimensões idênticas.
- Regras de redução de movimento e transparência já existem em `globals.css`; não considerei sua ausência como defeito.

## Sequência sugerida de melhoria

1. **Legibilidade e interação:** 01–04 e 13. Foco, cores de ação, textos auxiliares e áreas de toque.
2. **Componentes base:** 05–07 e 10–12. Variantes de botão/campo/slider/modal e escala tipográfica, com migração gradual.
3. **Acabamento das telas:** 08–09, 14 e 18. Configurações, avisos, tooltip e iconografia.
4. **Integrações e combinações:** 15–17. Camadas, aviso nativo e fullscreen em diferentes escalas.

Para cada etapa, comparar desktop e viewport mobile, testar teclado, hover, disabled/busy, erros e conteúdo longo. A adoção de componentes base precisa preservar permissões, handlers e navegação. Nenhuma dessas mudanças foi implementada nesta branch.
