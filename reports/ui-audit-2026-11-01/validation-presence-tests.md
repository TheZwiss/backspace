# Regressão da presença de chamada

Alterações: presença confirmada pelo WebSocket aparece antes de ParticipantConnected; saída explícita do canal atual filtra o participante SDK até a nova entrada ou a nova sessão. DMs e outros canais não usam esse fallback. Nenhuma mídia artificial foi publicada.

Comando final: pnpm --filter @backspace/web test src/hooks/useLiveKit.presence.test.ts src/hooks/useLiveKit.capture.test.ts src/hooks/useLiveKit.localRow.test.ts src/hooks/useLiveKit.streamResume.test.ts src/hooks/useLiveKit.streamRepublish.test.ts src/components/voice/SoundController.test.tsx src/components/voice/VoiceGrid.test.tsx src/components/voice/VoiceGrid.fullscreen.test.tsx src/components/voice/VoiceChannel.test.tsx src/utils/voice.reconnect.test.ts

Resultado:10 arquivos,125 testes aprovados. A presença contém8 testes, incluindo reconciliação, saída antesSDK, reentrada rápida, ausência genérica de roster, outro canal, DM, disconnect e troca de sessão.

pnpm --filter @backspace/web typecheck: aprovado. ESLint useLiveKit.ts, voiceStore.ts e useLiveKit.presence.test.ts com --max-warnings0 e --pass-on-unpruned-suppressions: aprovado (a flag evita exigir podar supressões globais durante uma execução parcial). git diff --check: aprovado. Os scripts de validação passaram node --check.

Avisos de ambiente mantidos: engine de duas ferramentas pede Node>=22.18 enquanto runtime usa22.13; Vite reporta imports sem extensão na configuração nativa; jsdom não implementa play/pause. Os testes aprovados não substituíram a verificação de mídia real no Electron, que avançou no mesmo track após o patch.

Resultados ao vivo: validation/join-presence-finding.md, validation/disconnect-presence-finding.md, validation/quick-reentry-after-fix.json e validation/presence-fix-media-smoke.json.
