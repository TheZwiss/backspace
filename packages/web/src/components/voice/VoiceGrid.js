import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo } from 'react';
import { VoiceUser } from './VoiceUser';
import { StreamTile } from './StreamTile';
import { useVoiceStore } from '../../stores/voiceStore';
import { deriveGridTiles } from '../../hooks/useLiveKit';
export function VoiceGrid({ participants }) {
    const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
    const setFocusedParticipant = useVoiceStore((s) => s.setFocusedParticipant);
    const tiles = useMemo(() => deriveGridTiles(participants), [participants]);
    // Unfocus if the focused stream tile no longer exists
    useEffect(() => {
        const currentStreamKeys = new Set(tiles
            .filter((t) => t.kind === 'stream' && t.screenTrack?.readyState === 'live')
            .map((t) => t.key));
        if (focusedParticipantId &&
            focusedParticipantId.endsWith(':stream') &&
            !currentStreamKeys.has(focusedParticipantId)) {
            setFocusedParticipant(null);
        }
    }, [tiles, focusedParticipantId, setFocusedParticipant]);
    if (tiles.length === 0) {
        return (_jsx("div", { className: "flex-1 flex items-center justify-center", children: _jsxs("div", { className: "text-center", children: [_jsx("svg", { width: "48", height: "48", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-text-muted/40 mx-auto mb-3", children: _jsx("path", { d: "M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" }) }), _jsx("p", { className: "text-discord-text-muted text-sm", children: "Waiting for others to join..." })] }) }));
    }
    const focusedTile = focusedParticipantId
        ? tiles.find((t) => t.key === focusedParticipantId)
        : null;
    // Render a single tile polymorphically
    const renderTile = (tile, large) => tile.kind === 'user' ? (_jsx(VoiceUser, { tile: tile, large: large })) : (_jsx(StreamTile, { tile: tile, large: large }));
    // Focus mode: one large tile + bottom strip
    if (focusedTile) {
        const otherTiles = tiles.filter((t) => t.key !== focusedParticipantId);
        return (_jsxs("div", { className: "flex-1 flex flex-col overflow-hidden relative", children: [_jsxs("div", { className: "flex-1 p-2 min-h-0 cursor-pointer", onClick: () => setFocusedParticipant(null), title: "Click to return to grid view", children: [renderTile(focusedTile, true), _jsxs("button", { onClick: (e) => {
                                e.stopPropagation();
                                setFocusedParticipant(null);
                            }, className: "absolute top-4 right-4 z-10 px-3 py-1.5 bg-black/60 hover:bg-black/80 rounded-lg flex items-center gap-2 text-white/70 hover:text-white transition-colors", title: "Back to grid view", children: [_jsx("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z" }) }), _jsx("span", { className: "text-xs font-medium", children: "Grid" })] })] }), otherTiles.length > 0 && (_jsx("div", { className: "h-[120px] flex-shrink-0 flex items-center justify-center gap-2 p-2 bg-[#111214]/50 overflow-x-auto no-scrollbar", children: otherTiles.map((t) => (_jsx("div", { onClick: () => setFocusedParticipant(t.key), className: "h-full aspect-video flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity", children: renderTile(t) }, t.key))) }))] }));
    }
    // Default grid mode
    const gridClass = (() => {
        if (tiles.length === 1)
            return 'grid-cols-1 max-w-2xl mx-auto';
        if (tiles.length === 2)
            return 'grid-cols-2 max-w-4xl mx-auto';
        if (tiles.length <= 4)
            return 'grid-cols-2';
        if (tiles.length <= 9)
            return 'grid-cols-3';
        return 'grid-cols-4';
    })();
    return (_jsx("div", { className: "flex-1 p-3 overflow-auto flex items-center min-h-0", children: _jsx("div", { className: `grid ${gridClass} gap-2 w-full max-h-full`, children: tiles.map((t) => (_jsx("div", { onClick: () => setFocusedParticipant(t.key), className: "cursor-pointer hover:opacity-90 transition-opacity h-full", children: renderTile(t) }, t.key))) }) }));
}
