# Diagnóstico dos travamentos dos clientes Electron

Em 01/11/2026, o Windows marcou o processo principal do cliente Bob (PID 33780) como sem resposta repetidamente, em intervalos de aproximadamente 15 segundos. Esse intervalo coincide com a execução periódica do detector de atividades e jogos.

Em um teste isolado com a implementação compilada e a lista real de 453 processos, a detecção completa levou aproximadamente 2,75 s. O detector Steam, isolado com o índice carregado, executou 8.838 chamadas síncronas a `fs.realpathSync`, consumindo cerca de 1,86 s. A comparação do catálogo levou cerca de 0,93 s em outra medição. A execução dessas operações na thread principal do Electron explica fortemente as pausas observadas; não foi coletada uma pilha nativa durante o travamento.

A resolução dos caminhos da Steam é repetida mesmo quando o índice está em cache: o argumento padrão de `loadSteamIndex` chama `getSteamRoots` antes da verificação do cache. O detector também resolve caminhos repetidamente ao verificar a relação entre executáveis e diretórios de jogos.

A investigação não encontrou evidência de que logs sejam a causa. Nenhuma correção foi aplicada. Recomenda-se mover a varredura para uma thread de trabalho e reduzir resoluções repetidas de caminhos por meio de cache, preservando o comportamento com links simbólicos.
