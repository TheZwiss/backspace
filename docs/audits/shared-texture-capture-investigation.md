# Próxima abordagem de captura: texturas compartilhadas

Correção de padding preservada no commit `938902a9` na branch perf/screen-share-preview.

## Alternativa barata rejeitada no teste ao vivo

Reaplicar visibleRect, displayWidth e displayHeight via new VideoFrame(frame, init), sem materializar uma nova superfície, manteve codedHeight=1088/displayHeight=1080. Após 359 quadros no teste, o receptor voltou a apresentar compressão para 1072 linhas: erro estático alinhando a 1072 = 1,231, alinhando a 1080 = 19,422. O teste usou uma derivação temporária da mesma captura, sem criar outro FFmpeg. O sender foi restaurado à faixa normalizada; a faixa original permaneceu live. A correção por superfície continua sendo a opção validada.

## API já presente no Electron instalado

Electron 43.7.5 / Chromium 150.0.7871.250. Os tipos locais electron.d.ts expõem sharedTexture.importSharedTexture no main, sendSharedTexture, setSharedTextureReceiver e SharedTextureImported.getVideoFrame. ImportTextureInfo aceita BGRA/RGBA e NV12; o handle Windows é um NT HANDLE válido no processo importador. A API é experimental.

Candidato: DXGI -> cópia GPU para textura compartilhada com dimensões visíveis exatas -> Electron sharedTexture -> VideoFrame -> generator -> WebRTC -> LiveKit. Assim a etapa intermediária de FFmpeg/H.264/HTTP/decoder deixa de ser necessária. Isso mantém a captura DXGI sem a borda WGC e pode evitar o canvas de normalização, dependendo da geometria entregue. Não elimina o encoder final WebRTC nem garante zero cópias internas do Chromium.

Ainda não implementado nem medido. Um protótipo isolado deve validar handles entre processos, adaptação à GPU capturada, sincronização/liberação de texturas, pool limitado e backpressure, cursor, resolução/FPS, reinício de GPU e mudança de monitor. Preservar o caminho atual como fallback. A ponte atual de preload usa contextIsolation e sandbox; a integração deve usar receiver no preload e uma transferência autorizada de frames, sem habilitar Node no conteúdo web.

## Fonte Chromium consultada

Foi obtido o arquivo media/gpu/windows/media_foundation_video_encode_accelerator_win.cc da tag exata 150.0.7871.250, não apenas HEAD. Ele contém caminhos separados de cópia e escala D3D com visible_rect. Isso não confirma sozinho qual ramo falhou no runtime: seria necessária instrumentação nativa para atribuir o defeito a uma função específica.

## Cursor no topo: baixa prioridade conforme usuário

Amostras em x=1660, y=0/1/4/8/16/32. No ROI estático do cursor, comparando com cursor em y=32, houve zero pixels distintos (>35 níveis RGB) em y=0/1/4/8, e 96 em y=16, tanto na faixa local quanto no receptor. Portanto o desaparecimento já existe antes do envio WebRTC. O FFmpeg local é 8.1.1 (Gyan essentials). O código atual upstream de ddagrab descarta o cursor quando mouse_x ou mouse_y é negativo, mesmo havendo tratamento posterior de interseção parcial; é compatível com um cursor cujo desenho/hotspot cruza a borda superior. A causa específica não foi instrumentada na build instalada. Nenhuma alteração no mouse foi aplicada, conforme prioridade indicada pelo usuário. A posição foi restaurada após os testes.

Fontes primárias:
- https://www.electronjs.org/docs/latest/api/shared-texture
- https://www.electronjs.org/docs/latest/api/structures/shared-texture-imported
- https://github.com/electron/electron/blob/main/shell/common/api/shared_texture/README.md
- https://chromium.googlesource.com/chromium/src/+/150.0.7871.250/media/gpu/windows/media_foundation_video_encode_accelerator_win.cc
- https://www.w3.org/TR/webcodecs/
- https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vsrc_ddagrab.c

Artefatos ignorados: tests/.tmp/edge-metadata-only.mjs, edge-metadata-restore.mjs, mf-runtime-encoder.cc, pointer-*-local.png, pointer-*-remote.png, edge-pointer-test.mjs.


## Protótipo executado e retorno ao caminho validado

Foi construído um laboratório independente em tests/.tmp/shared-texture-lab, sem alterar main/preload/captura do aplicativo. Compilação por MinGW g++ (a instalação local não oferece instância funcional do Visual Studio para CMake). O laboratório usa a mesma versão Electron 43.7.5, contextIsolation=true, nodeIntegration=false e sandbox=true. Os clientes Alice/Bob não foram reiniciados. A captura antiga foi pausada para que houvesse apenas uma Desktop Duplication ativa por vez.

1. **Importação básica:** textura D3D11 BGRA 64×64, NT HANDLE duplicado para o main, sharedTexture.sendSharedTexture para preload sandbox, getVideoFrame. Pixel observado [255,0,127,255], dimensões corretas e allReferencesReleased confirmado.
2. **Captura contínua:** helper C++ faz DXGI CopyResource em pool de 3 texturas compartilhadas e sinaliza prontidão após query D3D11/GPU. Importação no main; entrega no preload; VideoFrame transferido por window.postMessage para a página; generator publica H.264 no LiveKit local. Bob assina a identidade temporária texture_probe. Não há FFmpeg, H.264 intermediário, HTTP de vídeo, decoder intermediário ou canvas de normalização nessa cadeia. A página usa o mesmo ajuste de perfil H.264 e maintain-framerate do aplicativo.
3. **Rodada animada de 90s:** após aquecimento de banda, 1920×1080 a aproximadamente 59–61 FPS enviados. Total 5389 texturas importadas/liberadas, zero falhas de transferência e poolDrops=0. Outra rodada de 70s entregou 4189 texturas, também liberadas integralmente e sem falhas.
4. **Recursos do processo isolado:** árvore do laboratório, 19 amostras, CPU média 3,28%, working set 971 MiB, GPU Video Encode 14,0%, Video Decode 0%. Esse escopo exclui o processo Alice que produzia a animação e sua UI; não é comparação direta com a árvore completa do transmissor anterior. A coleta combinada terminou parcialmente após o laboratório sair e foi rejeitada como comparação de consumo. Não foi afirmado ganho percentual.
5. **Geometria:** quadro local BGRA codedHeight=displayHeight=1080 e receptor 1920×1080. Na comparação estática esquerda, altura 1080 teve erro médio 3,286 e a hipótese comprimida de 1072 teve 19,955; não apareceu a compressão inferior observada no caminho NV12 com padding.
6. **Bloqueio de estabilidade:** ler um quadro local clonado para uma imagem de canvas durante a transmissão derrubou o renderer do laboratório. Uma repetição registrou render-process-gone reason=crashed, exitCode=-1073741819 (0xC0000005). Essa rodada terminou após 1363 importações, com 1363 liberações e poolDrops=0. Reproduzido com texturas usando keyed mutex e também com BGRA usando SHARED_NTHANDLE|SHARED. Na segunda variante, o quadro chegou a ser lido e o crash ocorreu em seguida. Não houve navegação/reload registrado entre o carregamento inicial e o crash; o evento observado foi crash nativo. Não foi identificado o módulo/função nativo responsável.

**Decisão:** não promover o protótipo. O mecanismo é funcional e remove etapas, mas o crash com um uso válido de leitura de quadro é bloqueante. Contagem de liberações correta não prova que a sincronização de GPU e a vida útil das referências estão corretas. Ainda precisa isolar transferência entre mundos, clones do generator, leitura/composição e a importação nativa; não atribuir a causa ao Electron ou driver sem essa separação.

O helper experimental não compõe o cursor e só testa o output 0, BGRA e resolução nativa. Não houve validação de áudio, HDR, rotação, múltiplas GPUs, troca de monitor ou recuperação de device lost. Os artefatos ficam isolados e ignorados pelo Git. Os processos de laboratório foram encerrados e a transmissão de Alice via DXGI/H.264/normalização foi restaurada; Bob voltou a assinar Alice. A correção validada do commit 938902a9 continua sendo o caminho do aplicativo.

Fontes do protótipo: probe.cpp, capture.cpp, main.cjs, preload.cjs, stream-main.cjs, stream-preload.cjs e stream.html. Evidências: stream-run-animated.log, stream-stability.log, stream-no-mutex.log, geometry.json e os perf-shared-texture-*-resources.json. Os tokens usados foram temporários e gerados em memória a partir da configuração local, sem serem impressos em logs.


## Pesquisa de documentação e ocorrências oficiais

- Documentação sharedTexture: recurso experimental; a textura de origem deve continuar válida até allReferencesReleased. A API subtle documenta callbacks de release após comandos GPU e tokens de sincronização. O protótipo já respeita o callback para reciclar slots, portanto não é correto atribuir a falha apenas à falta de um contador de referências.
- PR Electron #53259: corrigiu vida útil do wrapper native de subtle.importSharedTexture e funções retidas após GC. Foi lançado em 43.5.0, anterior ao 43.7.5 instalado. Não é evidência de que atualizar resolverá nosso caso. O código fonte da tag v43.7.5 foi consultado: há guardas de referência liberada e ciclo de VideoFrame que retém ImportedSharedTexture.
- Electron #54553: importação de texturas e falhas de sincronização/cleanup/readback, mas em Linux/Vulkan (GPU crash, código 133). Nosso caso é Windows/D3D11, renderer crash 0xC0000005. O relato é relacionado, não uma correspondência confirmada.
- Electron #47705: problemas com objetos transferíveis (VideoFrame/OffscreenCanvas) entre iframe fora de processo e janela no Windows/Electron 35.3.0. Nosso protótipo usa mundos isolados da mesma janela e Electron 43.7.5; não é reprodução do mesmo cenário.
- PR #50473: crash de release de textura OSR após GC do objeto, com processo principal afetado. Nosso teste usa textura externa D3D11 e cai no renderer; não há stack que ligue os casos.

Conclusão: há ocorrências oficiais da mesma família de problemas, mas não foi encontrado um relato idêntico que explique o crash local. A próxima investigação deve reduzir a ponte preload→página e a sequência import/getVideoFrame/transfer/generator/clone/canvas, com minidump simbolizado para identificar a função que acessou memória inválida. Não foram alterados dependências ou flags do aplicativo com base apenas nesses relatos.

Links:
- https://www.electronjs.org/docs/latest/api/shared-texture
- https://www.electronjs.org/docs/latest/api/structures/shared-texture-imported-subtle
- https://releases.electronjs.org/pr/53259
- https://github.com/electron/electron/issues/54553
- https://github.com/electron/electron/issues/47705
- https://releases.electronjs.org/pr/50473
- https://raw.githubusercontent.com/electron/electron/v43.7.5/shell/common/api/electron_api_shared_texture.cc
- https://raw.githubusercontent.com/electron/electron/v43.7.5/lib/renderer/api/shared-texture.ts

## Isolamento do crash e simbolização local

Testes com texturas sintéticas D3D11, sem abrir outra Desktop Duplication: importação, getVideoFrame, clone, drawImage, readback e retenção de 25 ms passaram separadamente por aproximadamente 450–469 frames cada. Não houve crash nesses seis testes.

Em seguida, publicação LiveKit e inspeção de clone foram reunidas no mesmo preload sandbox. Não existe postMessage nem transferência entre mundos nessa variante. O readback de 1920×1080 terminou e o renderer caiu em seguida com 0xC0000005. Portanto a transferência preload→página não é condição necessária para reproduzir.

CrashReporter local, com uploadToServer=false, produziu um minidump. O identificador RSDS do executável instalado foi comparado com os símbolos oficiais: electron.exe.pdb / FA93794E22E98CCB4C4C44205044422E1. Foram consultados pequenos intervalos HTTP do arquivo Breakpad, sem baixar o PDB de vários GB. RIP relativo 0x1cd7125 resolve para v8::MicrotasksScope::MicrotasksScope, deslocamento 0x45. Exceção de leitura em 0x270, com registrador RDX nulo.

O unwind local das tabelas PE aponta o chamador gin_helper::V8FunctionInvoker<void()>::Go, seguido pelo caminho gpu::ImplementationBase::RunIfContextNotLost e gpu::CommandBufferProxyImpl::OnSignalAck. O código da tag v43.7.5 mostra a liberação de texturas sinalizando um callback JavaScript após conclusão GPU. Essa evidência localiza a falha no caminho de callback nativo/JavaScript após sinalização GPU; ainda não prova qual objeto perdeu validade nem autoriza afirmar que o próprio Local<Context> está nulo. Não há patch no Electron ou driver.

Artefatos locais ignorados: dumps-single, symbol-id.json, symbolized-crash.json, unwound-stack.json, symbolized-stack-candidates.json, callback.h/cc e unwind.py. Nenhum dump foi enviado.

Alternativa em avaliação: drawImage do frame importado para uma OffscreenCanvas própria e criação de um novo VideoFrame antes de writer.write. Isso mantém uma composição, mas elimina FFmpeg/H.264/HTTP/decoder intermediários. O primeiro teste sintético de 25 s completou 1488 importações/liberações, zero falhas e um readback de 1080p, sem crash. Parte desse teste teve dynacast pausado; não conta como transmissão contínua validada.

### Repetições com receptor assistindo

- Sintético, 60 s: 3586 importações e liberações, zero falhas de transferência, poolDrops=2, quatro descartes no receiver do preload, sete inspeções por clone/readback completo. Publicação em 1920×1080, aproximadamente 59–61 FPS após aquecimento. Uma amostra de Bob registrou 60 FPS e zero framesDropped. Sem rendererGone.
- DXGI real, 60 s: transmissão original pausada, apenas uma Desktop Duplication. Janela própria de animação aberta após o início; FPS de aproximadamente 29–31 antes da animação, depois 60 no encoder. Total 3451 importações/liberações, zero falhas de transferência, poolDrops=0, um descarte no preload, sete inspeções completas. Quatro amostras de Bob, espaçadas em três segundos, mostraram 1920×1080 a 60 FPS, framesDecoded aumentando e framesDropped=0. Sem rendererGone.
- Logs: canvas-repeat.log, canvas-real.log e canvas-real-receiver.json em tests/.tmp/shared-texture-lab. São ensaios curtos, não prova de estabilidade prolongada nem de ganho de consumo. Não houve medição comparável de CPU/GPU desta variante.
- Finalização: laboratório encerrou naturalmente; janela de animação fechada; publicação original de Alice restaurada e Bob novamente assinando Alice. Nenhum main/preload/fluxo de captura do aplicativo foi substituído.

A superfície própria contornou a reprodução nestes testes. Ela é candidata à próxima integração, ainda dependente de cursor, seleção de janela, áudio, múltiplos monitores/adaptadores, recuperação de GPU e fallback. Não equivale a corrigir o defeito nativo do Electron nem confirma a causa raiz do ponteiro nulo.

## Comparação de consumo A/B/A com a superfície própria

Executada uma rodada do caminho atual, uma do protótipo e outra do caminho atual. Mesmo desktop/output 0, mesma janela de animação de 1280×720 em primeiro plano, captura de tela inteira em 1920×1080, H.264, alvo de 60 FPS, teto de 15 Mbps, sem áudio, mesmo receptor Bob e LiveKit local. Uma Desktop Duplication ativa por vez. No protótipo, readbacks artificiais de diagnóstico foram desativados durante a medição.

Escopo: árvore completa de Alice, incluindo a janela que gera a animação, nas três rodadas; na rodada B, também a árvore do laboratório e helper C++. Excluídos Bob, servidor e ferramentas de coleta nas três rodadas. Assim não se compara um laboratório mínimo com o aplicativo completo. Entretanto o laboratório é outro Electron, com seu próprio renderer/GPU/processos utilitários, e essa duplicação pesa especialmente na memória; não representa a futura integração dentro do Electron existente.

Cada rodada tem 20 amostras de CPU/memória/GPU ao longo de aproximadamente 28–29 s após aquecimento. CPU é percentual da capacidade lógica total da máquina. GPU são contadores Windows separados por engine, somados pelos PIDs incluídos; não devem ser somados para afirmar um percentual global da GPU. A média do atual é a média das duas rodadas A.

| Métrica média | Atual (A/A2) | Protótipo (B) | Diferença observada |
| --- | ---: | ---: | ---: |
| CPU | 6,76% | 6,12% | −0,64 ponto percentual / −9,4% relativo |
| GPU Video Encode | 30,32% | 14,92% | −50,8% relativo nesse engine |
| GPU Video Decode | 11,99% | 0% | eliminada atividade intermediária nesse engine do transmissor |
| GPU 3D | 9,40% | 9,39% | praticamente igual |
| GPU Copy | 3,29% | 3,21% | praticamente igual |
| Memória privada | 1401,5 MiB | 1572,2 MiB | +170,7 MiB / +12,2% |
| Soma dos working sets | 1353,3 MiB | 2255,9 MiB | +902,6 MiB; inclui páginas compartilhadas potencialmente contadas várias vezes |

As duas rodadas A tiveram CPU 6,754% e 6,761%, Encode 30,334% e 30,302%, Decode 12,025% e 11,956%. Isso dá consistência ao resultado nesta sessão, sem substituir repetição em outros equipamentos/cargas. A rodada B completou 3588 texturas importadas/liberadas, zero falhas de transferência, poolDrops=1 e dois descartes no receiver do preload durante a sessão total; sem crash.

Bob teve 10 amostras de recepção por rodada, espaçadas em 2 s. Todas em 1920×1080. FPS médio do contador: A 59,4, B 60,0, A2 58,6; taxa derivada de framesDecoded: A 59,08/s, B 59,86/s, A2 59,16/s. Zero incremento de framesDropped nas três janelas de coleta. Bitrate efetivo: A 9,44 Mbps, B 8,36 Mbps, A2 9,34 Mbps. O teto foi igual, mas a taxa efetiva não: não foi feita avaliação objetiva de qualidade visual que autorize chamar isso de ganho de compressão. Tempo médio de decode no receptor: aproximadamente 0,305 ms/quadro no atual e 0,339 ms no protótipo, uma diferença pequena que não representa latência ponta a ponta.

Conclusão limitada aos testes: há ganho forte de trabalho de vídeo na GPU e redução modesta de CPU, mantendo aproximadamente 60 FPS. Não há ganho de memória no ambiente atual: o laboratório aumenta o consumo. Não foi medida latência de captura até apresentação nem qualidade visual comparável. O próximo teste de memória deve ocorrer após integração dentro do Electron existente, preservando fallback, antes de prometer economia global.

Artefatos ignorados em tests/.tmp/shared-texture-lab: baseline-a-resources.json, canvas-b-resources.json, baseline-a2-resources.json, respectivos arquivos receiver.json, comparison-summary.json, compare-canvas.log, compare-resources.ps1, compare-stats.mjs e summarize-compare.mjs. Encerrado o laboratório, fechada a animação e restaurada a transmissão normal de Alice para Bob; nenhuma alteração no fluxo de captura do aplicativo.

Fontes adicionais:
- https://raw.githubusercontent.com/electron/electron/v43.7.5/shell/common/gin_helper/callback.h
- https://symbols.electronjs.org/electron.exe.pdb/FA93794E22E98CCB4C4C44205044422E1/electron.exe.sym
