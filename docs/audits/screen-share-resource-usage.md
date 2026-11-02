# Consumo de recursos da transmissão

Branch: `perf/screen-share-preview`, criada de `Dev` após o merge `a1df5a28` das animações (`9a9e71fc`).

## Inconsistências encontradas e corrigidas

1. **Preview local sempre anexado.** O StreamTile anexava a faixa local a um vídeo mesmo quando o transmissor estava em outra aplicação. Agora tela inteira só tem preview com o documento visível e em foco. Perder foco remove o vídeo e desanexa o elemento via SDK. Retomar foco reanexa a mesma faixa. Não há stop, mute, unpublish nem troca de qualidade da transmissão por esse motivo.
2. **Regra única para fontes.** Tela inteira, janela e aba mostram o preview local somente com o documento visível e em foco. Voltar ao Backspace reanexa o vídeo da mesma faixa, sem depender do tipo da fonte.
3. **Miniatura a cada 30s com reprodução contínua.** O gerador mantinha um segundo vídeo oculto reproduzindo o fluxo integral entre as fotos. Agora solta o srcObject e pausa após capturar a miniatura; se nenhum frame chegar, libera em até 1,5s. Sem outros participantes, não abre esse player. Um participante que entra dispara uma captura quando não há miniatura recente. As miniaturas para os demais continuam existindo conforme a configuração de privacidade.
4. **Setup reproduzindo sem foco.** O preview antes de publicar continuava reproduzindo enquanto o usuário alternava para outra aplicação. Agora suspende apenas o player, preservando a captura escolhida. A enumeração periódica de fontes também deixa de rodar sem foco.

O foco considera o ownerDocument do tile: uma chamada destacada acompanha sua própria janela. A reprodução dos receptores não é suspensa ao simplesmente perder foco, pois podem assistir num segundo monitor.

## Pontos adicionais observados

- O VoiceGrid já usa um coletor de estatísticas para todos os tiles; o popover de conexão possui outra instância de useTrackStats. Com ambos montados, existem coletores separados. Ainda é candidato a compartilhamento de amostras por sala.
- Os badges de resolução/FPS consultam getSettings a cada 3s enquanto os tiles estão montados; o coletor de estatísticas usa 2s. Podem ser condicionados à visibilidade da UI em outra alteração.
- A captura/codificação necessária ao envio continua ativa. Remover o player local elimina um consumidor, mas não elimina o custo do encoder. Não foi alterado o servidor LiveKit, codec, resolução, FPS, áudio ou bitrate.

## Validação

Testes cobrem perda/retorno de foco sem stop da faixa publicada, retomada de janela e aba ao voltar ao aplicativo, reprodução remota preservada, descarte do player de miniaturas, timeout de frame e ausência de participantes, além dos caminhos de publicação, cancelamento e troca de fonte existentes. Build e typecheck web passaram.

Não há medição comparativa de CPU/GPU nem validação ponta a ponta com jogo nesta rodada. Os testes demonstram o ciclo de anexação/desanexação e a preservação das ações de transmissão, sem afirmar percentual de economia.
