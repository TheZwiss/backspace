# Notificações de solicitações de amizade

Novos eventos `friend_request_received` produzem um cartão no canto superior direito, com foto, nome e ações por ícones. O corpo do cartão abre a DM; o botão de check aceita; o botão de cruz recusa; o pequeno botão fechar apenas dispensa o aviso. As ações de aceitar/recusar não abrem a conversa. O cartão expira após 12 segundos, com no máximo três avisos simultâneos.

A lista carregada ao entrar no app não dispara notificações antigas. Eventos repetidos e cópias de uma solicitação pendente não disparam novos cartões. Respostas, cancelamentos e trocas de conta removem avisos que deixaram de ser válidos.

Configurações do usuário → Notificações → Solicitações de amizade controla ativação, som e apresentação no desktop. O modo Não perturbar é respeitado. O som usa o volume geral de efeitos. O fallback de notificação do sistema é silencioso para não duplicar o som já controlado pelo app.

No navegador ou com o app em foco, o cartão é React e usa o tema compartilhado. No Electron em segundo plano, a ponte nova abre uma janela transparente no canto superior direito do monitor principal, sem roubar foco. Ao voltar ao app, a janela nativa é dispensada para evitar duplicação. Em clientes com ponte antiga, há fallback para a notificação do sistema; a posição dessa notificação é controlada pelo sistema operacional.

A ponte valida o renderer de origem e os campos. Texto é escapado em HTML e fotos nativas são limitadas a imagens data URI. Ações são aplicadas somente se a conta e a solicitação ainda corresponderem ao estado atual. O clique para abrir restaura o app; aceitar e recusar não tiram o foco de outro aplicativo.

Validação: testes de deduplicação, expiração, Do Not Disturb, som desativado, ações independentes de abrir a DM, dispensa sem recusar, isolamento de conta e posição da janela nativa, inclusive em monitor com coordenadas negativas. Builds web e Electron aprovados. A ponte nativa nova requer reabrir o Electron; a tentativa automática de reinício foi rejeitada pela revisão de permissões com `blocked by policy`.
