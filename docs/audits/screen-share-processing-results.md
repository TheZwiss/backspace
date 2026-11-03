# Captura: referência e otimizações de processamento

## Referência antes destas alterações

Commit `a077b29e`, branch `perf/screen-share-preview`. GPU NVIDIA RTX 4070 SUPER, driver 596.49; 12 processadores lógicos. Alice transmite; Bob recebe na mesma sala de teste. Animação de canvas com 90 blocos coloridos em uma janela Electron dedicada, sem áudio. Configuração solicitada: H.264, 1080p60, modo gaming. Tela: fonte Tela 1; janela: Backspace Capture Benchmark. A resolução de janela preserva sua proporção. Não foi um teste de jogo exclusivo nem de áudio.

As coletas ocorreram antes das alterações de processamento desta rodada. A referência inclui as otimizações anteriores de preview/miniaturas. Dados resumidos em `screen-share-processing-baseline.json`; amostras brutas e scripts de repetição em `tests/.tmp/perf-*` (ignorados pelo Git).

| Métrica | Janela estável | Tela inteira |
|---|---:|---:|
| Captura | Monitor recortado por canvas | DXGI/H.264/decoder/generator |
| Resolução enviada | 1614 × 1080 | 1920 × 1080 |
| FPS enviados, delta de framesEncoded | 57,32 | 59,02 |
| FPS recebidos, delta de framesDecoded | 57,27 | Sem par de amostras do mesmo id |
| FPS da fonte de vídeo vistos pelo WebRTC | 57,27 | 58,87 |
| FPS entregues pelo generator nativo | Não se aplica | 60,17 |
| Descartes do writer no intervalo | Não se aplica | 0 |
| CPU média, normalizada pela máquina | 9,11% | 5,91% |
| Working set médio da árvore | 1173 MiB | 1175 MiB |
| Memória privada média da árvore | 1024 MiB | 1113 MiB |
| GPU 3D | 14,41% | 8,71% |
| GPU Video Encode | 10,86% | 30,02% |
| GPU Video Decode | 0% | 11,60% |
| GPU Copy | 2,82% | 3,22% |

CPU/RAM são da árvore de Alice, incluindo sua janela animada e helpers; não incluem a árvore de Bob. GPU são somas por tipo de engine dos PIDs dessa árvore, não uma porcentagem global da placa. Working set pode contabilizar páginas compartilhadas mais de uma vez. Recursos têm 19 amostras em aproximadamente 37–39s; WebRTC tem intervalo de 20s, com sobreposição parcial às amostras de recursos. São uma referência operacional, não ensaio estatístico com repetições. Não há comparação com repouso. Na primeira janela houve adaptação de banda a 360p; esse trecho foi preservado separadamente e repetido após estabilização. Linhas RTP antigas com zero frames não representam encoders adicionais ativos. O encoder WebRTC ativo foi NVIDIA H.264 Encoder MFT nos dois modos.

## Implementado

- Parser Annex B usa views em vez de copiar cada NAL duas vezes; unidades completas continuam sendo montadas em buffer próprio.
- Cartões de pausa/reconexão só redesenham e solicitam frame ao mudar texto, cor, dimensões ou após voltar ao vídeo real.
- Um coletor de estatísticas atende todos os consumidores, com exclusão de polls sobrepostos, reset de histórico ao trocar de sala e descarte de resultados após cleanup.
- Ponte de áudio transfere o buffer ao worklet; mantém envio convencional se a plataforma rejeitar a transferência.
- Configurações nativas pendentes usam revisões para evitar reinícios redundantes já aplicados. O decoder recebe o snapshot de configurações que iniciou sua sessão.
- Captura nativa sem outros participantes e sem preview local reduz a cadência para 5 FPS após 5s fora de foco. Foco ou chegada de participante restaura a taxa solicitada. O áudio não é alterado. Isso não tenta inferir espectadores apenas pelo protocolo de watch; havendo qualquer participante remoto, mantém a taxa.
- Resposta da captura informa o encoder intermediário efetivo em header e captureMetrics, separadamente do encoder WebRTC.
- Recorte nativo com dimensões iguais à saída não passa por download/scale redundante.

## Pontos que não foram habilitados

- Escala inteiramente na GPU: o FFmpeg local tem scale_d3d11, mas o teste real DXGI → scale_d3d11 → NVENC falhou ao criar textura (80070057). Não basta detectar o nome do filtro. A alternativa existente permanece.
- Remoção da codificação H.264 intermediária: exige integração nativa com o caminho WebRTC; não foi substituída por cópias de pixels na CPU.
- GOP/bitrate intermediário, codec de backup e escolha de GPU não foram alterados sem comparação de qualidade, compatibilidade e recuperação. A ordem de prioridade dos encoders permanece.
- Pausar a captura por ausência de watchers numa sala que ainda tem participantes exige validação adicional de clientes antigos e retomada. A economia automática implementada cobre sala vazia.

## Validação e próxima etapa

Suites focadas de captura/publicação, áudio, estatísticas e componentes passaram, assim como typecheck e builds web/desktop. A parte principal do Electron requer reabrir os clientes. Nenhuma economia pós-alteração está afirmada antes de repetir a coleta após esse reinício.

Repetir com a mesma animação, monitor, resolução, configuração, receptor, foco, warmup e escopo de processos. Acrescentar cartão pausado, sala vazia/entrada de participante, áudio e mudanças rápidas de qualidade. Comparar resolução real enviada e FPS, além de CPU/RAM/engines, antes de aceitar qualquer redução de consumo como ganho.


## Verificação após reiniciar Alice e Bob

Confirmados processos de teste em 9223/9224, URL local 5188 e compilação desktop com o header do encoder. Bob abriu deslogado e foi autenticado pela interface antes dos testes. Captura nativa informou `h264_nvenc`; o encoder WebRTC continuou NVIDIA H.264 Encoder MFT.

| Métrica | Janela antes → depois | Tela antes → depois |
|---|---:|---:|
| Resolução | 1614×1080 → 1614×1080 | 1920×1080 → 1920×1080 |
| FPS enviados | 57,32 → 56,90 | 59,02 → 58,94 |
| FPS recebidos depois | 56,85 | 58,89 |
| CPU da árvore | 9,11% → 8,63% | 5,91% → 5,90% |
| Working set da árvore | 1173 → 1181 MiB | 1175 → 1260 MiB |
| GPU 3D | 14,41% → 15,53% | 8,71% → 8,47% |
| GPU Video Encode | 10,86% → 11,35% | 30,02% → 29,71% |
| GPU Video Decode | 0% → 0% | 11,60% → 11,47% |

Não há evidência de ganho relevante de CPU/GPU na transmissão ativa a partir dessas amostras únicas. A fluidez foi preservada. A memória aumentou, principalmente na tela; o teste posterior teve mais trocas de fonte/repetições e não permite atribuir esse aumento a vazamento ou melhoria. Para investigar memória, repetir a partir de reinícios limpos com ciclos idênticos e medir também a liberação após parar.

A primeira amostra posterior de janela estava pausada, com zero frames; foi identificada e excluída da comparação. Uma primeira amostra de tela também foi separada por falta de controle do foco da animação. Nas repetições válidas, o foco nativo da janela foi confirmado via GetForegroundWindow e a geometria informou foreground=true, minimized=false, screen:0:0. A animação estava produzindo aproximadamente 183–186 callbacks/s. Isso não equivale ao FPS transmitido. O teste de tela captura o monitor inteiro com a janela de animação visível; não é jogo em fullscreen exclusivo.

Economia em sala vazia validada ao vivo: Bob saiu, Alice permaneceu fora de foco, a fonte nativa continuou live e entregou 4,99 FPS. Ao Bob entrar, voltou a 59,90 FPS; mesmo generator e transmissão preservados. A amostra pausada de janela também confirma zero frames repetidos após estabilizar o cartão. Não há medição equivalente anterior de CPU/GPU para atribuir percentual de economia nesses estados.

Dados resumidos em `screen-share-processing-after.json`; brutos e teste de retomada em `tests/.tmp/perf-after-*` e `tests/.tmp/perf-budget-live.json`. Testes de áudio com conteúdo real, memória em ciclos iguais e mudanças rápidas de qualidade ainda não foram repetidos ao vivo nesta verificação.


### Rodada curta solicitada depois

Amostra de 10s, aquecimento de 5s, sete amostras de recursos. Janela: fonte 1614×1080 a 56,75 FPS, mas saída WebRTC 1076×720 a 23,48 FPS; CPU 6,35%, working set 1083 MiB. Tela: fonte 1920×1080 a 59,19 FPS, saída 1280×720 a 59,29 FPS; CPU 6,54%, working set 1177 MiB. O WebRTC marcou bandwidth nos dois modos. NVENC confirmado no caminho nativo. Não comparar esses consumos diretamente à referência de envio em 1080p, nem atribuir a redução a otimização: a saída foi reduzida pelo WebRTC e o aquecimento foi menor. Dados brutos em tests/.tmp/perf-quick-*. Testes encerrados e janela animada fechada.


## Correção da preferência de adaptação

O modo gaming passou de balanced para maintain-framerate; texto permanece maintain-resolution. A preferência é enviada ao SDK nas opções da publicação, além de ser mantida nas atualizações posteriores do sender. Não foram alterados bitrate inicial, limites de banda ou configuração do servidor.

Validação: 49 testes de screen share/host limits/stop paths passaram; typecheck e build web passaram. Nos clientes reais, getParameters retornou maintain-framerate para gaming, maintain-resolution ao mudar para texto e novamente maintain-framerate ao voltar para gaming. Sala local com dois participantes, animação em primeiro plano, coleta WebRTC de 10s após 5s de aquecimento.

| Modo | Enviado | Recebido | Limitação no fim da amostra |
|---|---|---|---|
| Janela | 1614×1080, 57,21 FPS | 1614×1080, 57,11 FPS | none |
| Tela | 1920×1080, 59,36 FPS | 1920×1080, 59,36 FPS | none |

Transporte efetivo publisher→LiveKit: UDP host→host, porta remota 7882, RTT reportado no feedback remoto aproximadamente 1–1,3ms, fractionLost=0 e packetsLost=0 nos registros coletados. Banda de saída estimada observada: 5,13 Mbps na janela e 15,17 Mbps na tela. Esses dados não mostram TCP/relay ou perda nessa rodada; não demonstram qual foi a causa da estimativa baixa anterior. Não foi necessário alterar a rede local. Não há promessa de manter 1080p60 numa conexão congestionada: maintain-framerate pode reduzir a resolução e a disponibilidade de banda pode variar entre execuções.

Dados: tests/.tmp/perf-adaptation-*-rtc.json e tests/.tmp/adaptation-*-parameters.json. Testes encerrados, janela animada fechada e ambos os clientes mantidos abertos e logados.
