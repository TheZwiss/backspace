import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { VideoPreset } from 'livekit-client';
const PRESETS = [
    { value: '1080p60', label: '1080p 60fps', desc: '1920x1080, 10000 kbps' },
    { value: '1080p', label: '1080p 30fps', desc: '1920x1080, 5000 kbps' },
    { value: '720p60', label: '720p 60fps', desc: '1280x720, 5000 kbps' },
    { value: '720p', label: '720p 30fps', desc: '1280x720, 3000 kbps' },
    { value: '540p', label: '540p 30fps', desc: '960x540, 1500 kbps' },
    { value: '360p', label: '360p 30fps', desc: '640x360, 800 kbps' },
];
const QUALITY_MAP = {
    '1080p60': new VideoPreset(1920, 1080, 15_000_000, 60),
    '1080p': new VideoPreset(1920, 1080, 8_000_000, 30),
    '720p60': new VideoPreset(1280, 720, 8_000_000, 60),
    '720p': new VideoPreset(1280, 720, 5_000_000, 30),
    '540p': new VideoPreset(960, 540, 2_000_000, 30),
    '360p': new VideoPreset(640, 360, 1_000_000, 30),
};
export function VideoQualityPopover({ open, onClose, anchorRect }) {
    const popoverRef = useRef(null);
    const videoQuality = useVoiceStore((s) => s.videoQuality);
    const setVideoQuality = useVoiceStore((s) => s.setVideoQuality);
    const isCameraOn = useVoiceStore((s) => s.isCameraOn);
    useEffect(() => {
        if (!open)
            return;
        const handleClick = (e) => {
            if (popoverRef.current && !popoverRef.current.contains(e.target)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [open, onClose]);
    if (!open)
        return null;
    const handleSelect = async (quality) => {
        setVideoQuality(quality);
        onClose();
    };
    return (_jsxs("div", { ref: popoverRef, className: "absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-[240px] bg-[#2b2d31] rounded-lg shadow-lg border border-[#1e1f22] z-50 overflow-hidden", children: [_jsx("div", { className: "px-3 py-2 border-b border-[#1e1f22]", children: _jsx("span", { className: "text-[14px] font-bold text-discord-text-primary", children: "Video Quality" }) }), _jsx("div", { className: "py-1", children: PRESETS.map((preset) => (_jsxs("button", { onClick: () => handleSelect(preset.value), className: `w-full px-3 py-2 flex items-center justify-between hover:bg-discord-modifier-hover transition-colors ${videoQuality === preset.value ? 'text-discord-text-primary' : 'text-discord-text-secondary'}`, children: [_jsxs("div", { className: "text-left", children: [_jsx("div", { className: "text-[14px] font-medium", children: preset.label }), _jsx("div", { className: "text-[12px] text-discord-text-muted", children: preset.desc })] }), videoQuality === preset.value && (_jsx("svg", { width: "20", height: "20", viewBox: "0 0 24 24", fill: "currentColor", className: "text-discord-blurple flex-shrink-0 ml-2", children: _jsx("path", { d: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" }) }))] }, preset.value))) })] }));
}
