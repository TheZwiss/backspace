# Matriz de cobertura

`Medido` indica amostras repetidas. `Inspecionado` indica abertura e verificação funcional, com evidência de estado/captura, sem distribuição estatística suficiente para p95. As repetições entre desenvolvimento e produção não representam novas telas.

## Páginas e configurações

| Superfície | Estado | Evidência |
|---|---|---|
| Amigos, exploração, Backspace e canal de texto | Medido: inicial + 20, desenvolvimento e produção | `measurements.json`, grupos `development` e `production` |
| Canal de voz, conexão, desconexão e recepção de vídeo | Inspecionado por fluxo real | `tests/.tmp/ui-audit/screen-share/` |
| DM individual e DM em grupo | Medido: 5 | `production/extras/results.json` |
| Login e primeira etapa de cadastro | Medido: 20 por rota | `production/auth.json` |
| Segunda etapa do cadastro e criação completa da conta | Inspecionado; autenticação posterior confirmada | `production/call.json` |
| Convite inválido | Inspecionado | `production/auth.json` |
| Configurações pessoais: conta, aparência, voz/vídeo, privacidade, figurinhas, conexões, atalhos, desktop | Medido: inicial + 20 | `development` |
| Configurações de espaço: visão geral, descoberta, membros, cargos, banimentos, efeitos sonoros, figurinhas | Medido: inicial + 20 | `development` |
| Administração: Geral, Cadastro, Federação, Transmissão, Armazenamento, Usuários, Atualizações e Oi | Medido: inicial + 20, com administrador real em banco isolado | `production` |
| Usuário comum tentando acessar estatísticas administrativas | Inspecionado; resposta 403 confirmada | `production/call.json` |

## Modais, confirmações e popovers

| Componente ou fluxo | Estado |
|---|---|
| CreateSpace, JoinSpace, CreateChannel, CreateCategory | Medido; entradas reais de criação/entrada também verificadas |
| InviteModal | Medido; abertura, campos e estado de amigos disponíveis |
| NewDmModal, AddDmMemberModal | Medido; lista real de amigos de teste |
| GroupDmSettings | Medido nas abas Visão geral e Membros |
| Confirmações de transferir propriedade e remover membro de grupo | Inspecionadas; canceladas |
| TransferOwnershipModal do espaço | Inspecionado, incluindo estado com poucos membros elegíveis; sem confirmar transferência |
| SpaceProfileModal e UserProfileModal | Medidos; abas de amigos/espaços em comum também exercitadas |
| MemberRolesModal e RolesPanel | Medidos com os cargos disponíveis no espaço de teste |
| ChannelSettingsModal e CategorySettingsModal | Medidos; abas de permissões exercitadas separadamente |
| Confirmações de excluir canal e categoria | Inspecionadas; Escape preserva o modal pai |
| DeleteAccountModal | Aviso inicial inspecionado; Escape fecha também as configurações, defeito F07 |
| BookmarksModal | Medido no estado disponível |
| ConnectedInstances | Inspecionado pelo painel Conexões; dados locais/sem pares externos reais |
| ImagePreview | Medido com imagem gerada para teste |
| ImageCropModal | Medido por seleção real de arquivo no campo de avatar; captura de tela confirma o diálogo sobre a conta |
| OwnerTitleHeading: edição do título do dono | Medido; sem salvar alteração |
| ChannelHeaderTopic: tópico completo | Inspecionado com tópico de duas linhas; o valor anterior foi restaurado |
| MemberNicknameDialog | Aberto pelo menu contextual de Bob no espaço; cancelado sem salvar |
| ChannelNotificationPopover | Medido |
| NotificationSettingsModal do espaço | Inspecionado pelo menu contextual do espaço |
| Transferências | Medido no estado disponível |
| Emoji/InputPopover | Inspecionado |
| StickerPicker | Inspecionado |
| StickerStoreModal | Explorar, Criados por mim e Revisão inspecionados |
| StickerPackManageModal | Editor de criação inspecionado; sem publicar pacote |
| IncomingCallModal | Chamada real recebida em cerca de 52 ms nessa execução; recusa confirmada |
| HelloModal | Inspecionado no onboarding administrativo; adiado antes das medições válidas de páginas |
| Informações da conexão e menus de dispositivos de entrada/saída | Inspecionados durante conexão de voz |
| TextVoice: compositor de voz por texto | Inspecionado; sem iniciar preparação/download de modelo ou fala |
| Soundboard: gerenciador e seletor | Inspecionados; gerenciador com medições repetidas |
| ScreenShareSetup | Fontes, seleção de janela, preview, qualidade, iniciar, cancelar e reabrir exercitados |
| ScreenShareSettingsPopover e menu contextual do stream | Inspecionados durante transmissão; viewport mínimo reproduziu controles inacessíveis |

## Movimentos rápidos na transmissão

| Cenário | Resultado observado |
|---|---|
| Três rajadas de dez alterações de qualidade no preview | Configuração final acompanhou a última escolha; FPS do canvas existente permaneceu no valor inicial |
| Cinco rajadas de quatro escolhas de janela | Captura anterior substituída; uma captura instrumentada ativa após estabilizar |
| Abrir/cancelar rapidamente em cinco pares adicionais | Sem captura instrumentada ativa ao final |
| Dez ciclos completos de abrir, aguardar preview e cancelar | Fontes p95 723 ms; preview p95 989 ms |
| Três rajadas de qualidade durante transmissão ativa, incluindo codec | Retirada temporária de `<video>` no receptor durante republicação; recuperação posterior |
| Trocar transmissão e cancelar | Publicação anterior não é mantida |
| Solicitar miniaturas logo após atualizar só metadados | Oito fontes retornadas sem miniaturas pelo cache |
| Opções da transmissão em 1280×500 | Áudio e ação de parar fora do viewport, sem rolagem |

Algumas tentativas exploratórias de clicar em uma fonte antes de o tab correspondente estar disponível foram descartadas como amostras de controle. Não foram classificadas como defeitos da aplicação. A contagem de rajadas acima se refere às sequências de fonte/qualidade válidas; os pares de cancelar/reabrir têm verificação independente no arquivo de timings.

## Pré-condições e limites explícitos

| Superfície ou cenário | Situação |
|---|---|
| Seletor de GIF | Botão não exibido pelo estado `gifEnabled` disponível. Provedor/chave e busca externa não validados |
| ConnectAndJoinModal, senha remota, reautenticação/reattach federado | Sem par federado real configurado para completar esses fluxos; leitura do código não foi contada como inspeção de execução |
| Revisão/rejeição de pacote com itens, compartilhamento externo de álbuns e configurações de pares | Estados que exigem fixtures remotas ou itens pendentes não exercitados; abas vazias foram abertas |
| Variantes de moderação por permissão | Diálogo de apelido e confirmações principais abertos; combinações de cargo e hierarquia não foram percorridas integralmente |
| Autorização/negação do sistema, macOS, Wayland e fontes exclusivas de jogos | Fora do ambiente Windows disponível |
| Câmera real e processamento/download de modelos de voz | Painéis inspecionados; hardware/modelos não ativados |
| Áudio do sistema transmitido e alterações rápidas de áudio | Alcance e UI do controle inspecionados; som recebido e rajadas de aquisição de áudio não foram validados |
| Fullscreen e janela de chamada destacada durante rajadas | Entradas disponíveis identificadas; não receberam a mesma rodada completa de medição |
| Centenas de membros, milhares de mensagens e anexos pesados | Sem teste de carga; não extrapolar os números das fixtures pequenas |
| Escalas de interface acima de 100% e MobileShell | Não medidos nesta execução; incluídos na regressão proposta para as correções de layout |

A matriz registra essas pendências para que a auditoria não seja apresentada como cobertura integral de estados que não foram executados.
