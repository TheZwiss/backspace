import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
import { VoiceUser } from './VoiceUser';
import { useVoiceStore } from '../../stores/voiceStore';
export function VoiceGrid({ participants }) {
    const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
    const setFocusedParticipant = useVoiceStore((s) => s.setFocusedParticipant);
    const prevScreenSharerRef = useRef(null);
    // Auto-focus when someone starts screen sharing
    useEffect(() => {
        const screenSharer = participants.find((p) => p.screenTrack?.readyState === 'live');
        const screenSharerId = screenSharer?.identity ?? null;
        if (screenSharerId && screenSharerId !== prevScreenSharerRef.current) {
            // New screen share started — auto-focus
            setFocusedParticipant(screenSharerId);
        }
        else if (!screenSharerId && prevScreenSharerRef.current) {
            // Screen share ended — unfocus if we were focused on the sharer
            if (focusedParticipantId === prevScreenSharerRef.current) {
                setFocusedParticipant(null);
            }
        }
        prevScreenSharerRef.current = screenSharerId;
    }, [participants, focusedParticipantId, setFocusedParticipant]);
    if (participants.length === 0) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center", children: _jsxs("div", { className: "text-center", children: [_jsx("svg", { width: "48", height: "48", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted/40 mx-auto mb-3", children: _jsx("path", { d: "M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" }) }), _jsx("p", { className: "text-discord-text-muted text-sm", children: "Waiting for others to join..." })] }) }));
    }
    const focusedParticipant = focusedParticipantId
        ? participants.find((p) => p.identity === focusedParticipantId)
        : null;
    // Focus mode: one large tile + sidebar strip
    if (focusedParticipant) {
        const otherParticipants = participants.filter((p) => p.identity !== focusedParticipantId);
        return (_jsxs("div", { className: "flex-1 flex overflow-hidden", children: [_jsxs("div", { className: "flex-1 p-2 relative", children: [_jsx(VoiceUser, { participant: focusedParticipant, large: true }), _jsxs("button", { onClick: () => setFocusedParticipant(null), className: "absolute top-4 right-4 z-10 px-3 py-1.5 bg-black/60 hover:bg-black/80 rounded-lg flex items-center gap-2 text-white/70 hover:text-white transition-colors", title: "Back to grid view", children: [_jsx("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z" }) }), _jsx("span", { className: "text-xs font-medium", children: "Grid" })] })] }), otherParticipants.length > 0 && (_jsx("div", { className: "w-[200px] flex-shrink-0 overflow-y-auto p-2 space-y-2 bg-[#111214]/50", children: otherParticipants.map((p) => (_jsx("div", { onClick: () => setFocusedParticipant(p.identity), className: "cursor-pointer hover:opacity-80 transition-opacity", children: _jsx(VoiceUser, { participant: p }) }, p.identity))) }))] }));
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
    return (_jsx("div", { className: "flex-1 p-3 overflow-auto flex items-center", children: _jsx("div", { className: `grid ${gridClass} gap-2 w-full`, children: participants.map((p) => (_jsx("div", { onClick: () => setFocusedParticipant(p.identity), className: "cursor-pointer hover:opacity-90 transition-opacity", children: _jsx(VoiceUser, { participant: p }) }, p.identity))) }) }));
}
