# Faixa inferior no receptor — investigação ao vivo

Transmissão existente de Alice para Bob, tela 1920×1080, caminho nativo NV12/H.264. Não foi encerrada nem trocada a fonte do usuário. Uma clone temporária da faixa local foi lida por MediaStreamTrackProcessor, cancelada e parada sem parar a faixa publicada. O receptor foi amostrado pelo vídeo existente. Captura GDI do monitor primário foi usada para conferir a origem.

## Evidências

- Fonte física, bitmap local e bitmap remoto: 1920×1080.
- Quadro local após generator: codedWidth=1920, codedHeight=1088, displayWidth=1920, displayHeight=1080, visibleRect=(0,0,1920,1080), formato NV12.
- Quadro do receptor: codedWidth=1920, codedHeight=1088, visibleRect=(0,0,1920,1080).
- Elemento remoto: object-fit=contain, transform=none. Dimensões CSS observadas 931×524 antes da captura dos quadros. Não há stretch explícito de 5px no CSS.
- A região estática da imagem local preserva as posições verticais da fonte física; o bitmap remoto apresenta compressão vertical progressiva.
- Comparação da região estática x=[0,350), y=[0,1000): erro absoluto médio entre local/remoto sem correção de escala = 19,433 níveis RGB. Redimensionando apenas para análise o bitmap local para altura 1072, erro = 1,448; alturas 1071 e 1073 resultam em 5,369 e 4,804. Isso é consistente com conteúdo de 1080 linhas sendo comprimido para aproximadamente 1072.
- 1080×1080/1088 = 1072,06. O tamanho da faixa restante coincide com as oito linhas de padding do quadro interno.

## Conclusão e limite

A deformação já está nos pixels do vídeo recebido; não é criada apenas pelo layout. A imagem local lida após o generator está correta, portanto o defeito foi localizado entre o consumo da faixa pelo WebRTC e a saída decodificada no receptor. A hipótese forte é uso incorreto da altura codificada/padding na passagem de superfícies NV12 pelo caminho acelerado. Não foi isolado ainda o encoder do transmissor versus decoder do receptor. CodedHeight=1088 sozinho é normal e não comprova bug; os pixels e a razão de escala são a evidência adicional.

Não foram alterados codec, captura, enquadramento, fontes nem código do aplicativo. Um próximo teste deve comparar uma entrada normalizada em superfície GPU com dimensões visíveis exatas contra a entrada NV12 atual, preservando as 1080 linhas; cortar a faixa do receptor esconderia o erro e manteria a compressão do restante da imagem.

Artefatos locais ignorados pelo Git: tests/.tmp/edge-source.png, edge-local.png, edge-remote.png, edge-geometry.json; scripts edge-compare.mjs e inspect-receiver-edge.mjs.


## Correção e validação

As alterações anteriores foram preservadas no commit 1b4142a5 antes de iniciar esta correção. Um teste reversível inseriu uma superfície OffscreenCanvas de tamanho visível exato entre uma clone da faixa nativa e o sender WebRTC; restaurar a faixa original restaurou o caminho anterior. Com a superfície normalizada, a comparação passou a ter melhor correspondência na altura integral de 1080, não em 1072. Isso localiza o comportamento problemático no caminho que consome a superfície NV12 com padding para envio WebRTC; o decoder remoto continuou declarando 1088/1080 como antes.

A implementação normaliza somente VideoFrames com padding ou offset visível, usando drawImage que respeita visibleRect e uma superfície reutilizada em displayWidth×displayHeight. Não há cópia explícita para buffers CPU, getImageData ou copyTo. Timestamp/duração são preservados, e tanto o frame original quanto o novo são fechados na etapa correta. Quadros sem padding passam direto. A conversão pode acrescentar trabalho de composição/conversão de cor; não se presume custo zero nem garantia de execução exclusivamente na GPU.

Com o código incorporado, no receptor: bitmap local e remoto 1920×1080; fonte local após generator codedHeight=1080; decoder remoto codedHeight=1088, visibleRect 1080. Região estática esquerda: erro médio sem redimensionamento = 0,611; redimensionando a imagem local para 1072 = 19,262. A deformação foi eliminada na amostra.

Teste com animação: saída 1920×1080 a 58,66 FPS, qualityLimitationReason=none; 593 frames normalizados no intervalo. Tempo médio de submissão da normalização no renderer = 0,154ms/frame, que não mede todo o tempo assíncrono da GPU. CPU média da árvore na coleta curta = 6,13%, working set = 1286 MiB; sem ensaio pareado suficiente para afirmar ganho de consumo. Testes unitários/de regressão: 43 passaram. Typecheck e build web passaram. A janela animada temporária foi fechada; a transmissão de tela permanece ativa para conferência visual.

Artefatos: tests/.tmp/perf-edge-fixed-screen-rtc.json, perf-edge-fixed-screen-resources.json, edge-geometry.json, edge-local.png, edge-remote.png. A/B temporário: edge-normalize-live.mjs, edge-restore-live.mjs.
