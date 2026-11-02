# Validação das alterações no Electron

Dois clientes reais: Alice/9223 e Bob/9224, ambos autenticados. Auditoria principal em Alice; Bob usado como receptor e no teste de presença solicitado. Nenhuma janela principal foi encerrada. O objetivo desta rodada é testar e identificar regressões, não declarar que todos os problemas encontrados já foram corrigidos.

## Testes automatizados e compilação

Primeira rodada: 168 testes web + 19 desktop = 187 testes focados aprovados. Typecheck web e build TypeScript desktop aprovados. Comandos e diagnósticos estão em [validation-capture-tests.md](validation-capture-tests.md) e [validation-dialog-tests.md](validation-dialog-tests.md). Os avisos de mediaElement do jsdom não comprovam reprodução real; essa parte foi medida separadamente no Electron.

## Resultados ao vivo

| Caso | Resultado | Evidência |
| --- | --- | --- |
| Popover 1280×500 | Passou: painel termina em y459; parar y410,5–446 e áudio y329,5–353,5 têm hit-test válido após scroll | validation/popover-minimum-500.json/png |
| Popover fullscreen | Passou: portal dentro do elemento fullscreen e parar clicável | validation/popover-fullscreen.json/png |
| Popover janela de chamada 960×500 | Passou: altura451, scroll interno e parar clicável | validation/popover-call-window-minimum.json/png |
| Modais aninhados/Tab/Escape | Passou: 15 Tabs contidos; Escape fecha só Excluir conta; segundo Escape fecha configurações; após animação, zero inert e foco no botão original | validation/nested-modal-focus.json e nested-modal-closed-settled.json/png |
| Cancelar troca e cancelar captura simulada | Publicação e configuração anteriores preservadas; vídeo do receptor avança; captura staged termina | validation/replacement-cancel.json e replacement-capture-failure.json |
| Rajadas de seleção de fonte | 10 trocas; Start desabilitado durante preparo; última captura é a confirmada, demais encerradas | validation/replacement-rapid-confirm.json |
| Isolamento entre preview e transmissão atual | FALHOU: mesmo track publicado muda de822×540 para864×540 ao preparar Bob, antes de confirmar; volta após cancelar | validation/replacement-geometry-contamination.json e replacement-geometry-after-cancel.json |
| Rajadas de codec | Cinco rajadas: uma republicação cada e captura nativa permanece a mesma; zero remoções do elemento vídeo ou amostras sem vídeo no DOM | validation/rapid-codec.json |
| Primeiro quadro após codec | Pendência: um overlay durou3103,7ms, com2,8s sem quadro após attach. Repetição com RTP após recarregar só Bob retomou em350ms, sem perda de pacotes. Causa intermitente ainda não isolada | validation/rapid-codec.json e cold-vp9-rtp.json |
| Parar no meio de mudança de codec | Passou: só unpublish; não republica; receptor sem vídeo e zero captures live | validation/rapid-codec-stop.json |
| Parar/reassistir rapidamente | Passou: três ciclos usando mesmo track remoto; depois frames aumentam de75 para162 e tempo de53,761 para55,266s | validation/receiver-unwatch-rewatch.json |
| Cache metadados→miniaturas | Passou: metadata retorna0imagens sem apagá-las; consulta completa imediata retorna7miniaturas em0,5ms | validation/native-source-cache.json |
| Pedidos simultâneos de fontes | Cinco grupos de três responderam juntos, com imagens; unidade comprova uma promise/scan compartilhado. O benchmark externo sozinho não conta chamadas internas desktopCapturer | validation/native-source-cache.json e testes screenSourceCache |
| Fontes e abrir/cancelar | Cancelamento responsivo e zero capturas residuais; persistem picos de scan nativo e primeira lista | validation/setup-reopen-timings.json e native-source-cache.json |
| Menu de contexto na janela separada | FALHOU: clique direito no vídeo filho cria menu no documento principal | validation/call-window-context-menu-wrong-document.json/png |
| Entrada na chamada solicitada pelo usuário | Reproduzido atraso de até2,99s. WebSocket confirmado em~160–220ms; sinal do LiveKit pode ficar no lote de3s para não-publicadores. CORRIGIDO e repetido nas duas direções: DOM97–246ms, sem duplicação após aviso SDK | validation/join-presence-finding.md |

Os achados de geometria e da janela separada descrevem o estado observado; esta rodada não estabeleceu se cada um já existia antes das alterações.

## Medições resumidas

- Lista de fontes no seletor, dez aberturas: mediana 511.4ms, máximo 3448.1ms. Preview: mediana 761.0ms, máximo 3726.7ms. Cancelar: mediana 12.2ms. Cinco pares rápidos também terminaram sem captures live.
- Consulta nativa em grupos simultâneos: valores normais próximos de96–111ms e pico2841ms; a melhoria de cache não eliminou os picos da enumeração fresca.
- Preview alvo 30fps: aproximadamente 28.8 callbacks apresentados/s em5s; mesmo track e mesma contagem de capturas nas três alterações.
- Preview alvo 45fps: aproximadamente 42.99 callbacks apresentados/s em5s; mesmo track e mesma contagem de capturas nas três alterações.
- Preview alvo 60fps: aproximadamente 54.18 callbacks apresentados/s em5s; mesmo track e mesma contagem de capturas nas três alterações.

O canvas manual informa frameRate=0 em getSettings; os FPS acima vêm de requestVideoFrameCallback e contadores de quadros, não desse metadado. Os resultados mostram resposta à seleção de FPS sem recaptura; não provam60fps exatos sob toda carga.

## Prioridades encontradas

1. Isolar geometry-watch da transmissão e do preview, preservando a fonte atual enquanto se prepara outra.
2. Antecipar a presença da chamada pelo WebSocket e reconciliar com o LiveKit; não publicar mídia artificial para acelerar eventos.
3. Direcionar menu e seletor da janela de chamada ao documento de origem.
4. Instrumentar os picos intermitentes de primeiro frame VP9 e enumeração nativa antes de propor mudanças de codec/driver.

A presença de entrada e saída foi corrigida e medida novamente: entrada97–246ms, saída10–15ms para a atualização do DOM no outro cliente. O lote do LiveKit continua existindo, mas deixou de bloquear a atualização visual. Houve seis entradas e seis saídas medidas depois das respectivas correções, mais dois ciclos de reentrada rápida sem duplicar ou perder o participante. A mídia real continuou avançando após o patch.

Regressão final de presença:125 testes em10 arquivos aprovados, mais typecheck e lint. Esses testes se sobrepõem parcialmente à rodada inicial de187 e não devem ser somados como um total de testes únicos.

Achados ainda abertos: interferência de geometry-watch entre preview e transmissão; menu da janela separada aparecendo na janela principal; pico intermitente de primeiro frame VP9 e picos de enumeração nativa. A validação os documentou, mas não corrigiu esses itens nesta rodada. Não foi feito commit ou push.

Detalhes da correção: [entrada](validation/join-presence-finding.md) e [saída](validation/disconnect-presence-finding.md).

## Estado final verificado

Alice/9223 e Bob/9224 permaneceram abertos e autenticados em /channels/@me. Ambas as sessões terminaram fora de voz/transmissão, sem vídeos e com zero marcadores de saída. Nenhum processo geometry-watch permaneceu. Instrumentação temporária foi removida por recarregamento dos renderers após encerrar os recursos de teste. Evidência: validation/final-state.json/png.
