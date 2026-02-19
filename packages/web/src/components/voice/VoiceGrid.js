import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { VoiceUser } from './VoiceUser';
import { useVoiceStore } from '../../stores/voiceStore';
export function VoiceGrid({ participants }) {
    const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
    const setFocusedParticipant = useVoiceStore((s) => s.setFocusedParticipant);
    if (participants.length === 0) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center text-discord-text-muted", children: _jsx("p", { children: "No one is in this voice channel" }) }));
    }
    const focusedParticipant = focusedParticipantId
        ? participants.find(p => p.identity === focusedParticipantId)
        : null;
    // Focus mode: one large tile + sidebar strip
    if (focusedParticipant) {
        const otherParticipants = participants.filter(p => p.identity !== focusedParticipantId);
        return (_jsxs("div", { className: "flex-1 flex overflow-hidden", children: [_jsx("div", { className: "flex-1 p-2", onDoubleClick: () => setFocusedParticipant(null), children: _jsx(VoiceUser, { participant: focusedParticipant, large: true }) }), otherParticipants.length > 0 && (_jsx("div", { className: "w-[200px] flex-shrink-0 overflow-y-auto p-2 space-y-2", children: otherParticipants.map((p) => (_jsx("div", { onClick: () => setFocusedParticipant(p.identity), className: "cursor-pointer", children: _jsx(VoiceUser, { participant: p }) }, p.identity))) }))] }));
    }
    // Default grid mode
    const gridClass = (() => {
        if (participants.length === 1)
            return 'grid-cols-1 max-w-2xl mx-auto';
        if (participants.length === 2)
            return 'grid-cols-2 max-w-4xl mx-auto';
        if (participants.length <= 4)
            return 'grid-cols-2';
        if (participants.length <= 9)
            return 'grid-cols-3';
        return 'grid-cols-4';
    })();
    return (_jsx("div", { className: "flex-1 p-4 overflow-auto", children: _jsx("div", { className: `grid ${gridClass} gap-2 h-full`, children: participants.map((p) => (_jsx("div", { onClick: () => setFocusedParticipant(p.identity), className: "cursor-pointer", children: _jsx(VoiceUser, { participant: p }) }, p.identity))) }) }));
}
