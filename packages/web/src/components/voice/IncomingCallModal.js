import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { wsSend } from '../../hooks/useWebSocket';
export function IncomingCallModal() {
    const incomingCall = useVoiceStore((s) => s.incomingCall);
    const setIncomingCall = useVoiceStore((s) => s.setIncomingCall);
    const timerRef = useRef(null);
    // Auto-dismiss after 30 seconds
    useEffect(() => {
        if (incomingCall) {
            timerRef.current = setTimeout(() => {
                // Auto-reject after timeout
                wsSend({ type: 'dm_call_reject', dmChannelId: incomingCall.dmChannelId });
                setIncomingCall(null);
            }, 30000);
        }
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [incomingCall, setIncomingCall]);
    if (!incomingCall)
        return null;
    const handleAccept = () => {
        if (timerRef.current)
            clearTimeout(timerRef.current);
        wsSend({ type: 'dm_call_accept', dmChannelId: incomingCall.dmChannelId });
    };
    const handleDecline = () => {
        if (timerRef.current)
            clearTimeout(timerRef.current);
        wsSend({ type: 'dm_call_reject', dmChannelId: incomingCall.dmChannelId });
        setIncomingCall(null);
    };
    return (_jsxs("div", { className: "fixed inset-0 z-[100] flex items-center justify-center", children: [_jsx("div", { className: "absolute inset-0 bg-black/60" }), _jsxs("div", { className: "relative bg-[#1e1f22] rounded-lg shadow-2xl w-[340px] overflow-hidden", children: [_jsxs("div", { className: "absolute inset-0 overflow-hidden", children: [_jsx("div", { className: "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200px] h-[200px] rounded-full bg-discord-green/5 animate-ping", style: { animationDuration: '2s' } }), _jsx("div", { className: "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[150px] h-[150px] rounded-full bg-discord-green/10 animate-ping", style: { animationDuration: '2s', animationDelay: '0.5s' } })] }), _jsxs("div", { className: "relative p-8 flex flex-col items-center gap-4", children: [_jsxs("div", { className: "relative", children: [_jsx("div", { className: "w-20 h-20 rounded-full bg-discord-blurple flex items-center justify-center text-white text-3xl font-bold", children: incomingCall.callerName.charAt(0).toUpperCase() }), _jsx("div", { className: "absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-discord-green flex items-center justify-center", children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "white", children: _jsx("path", { d: "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" }) }) })] }), _jsxs("div", { className: "text-center", children: [_jsx("h3", { className: "text-[20px] font-bold text-discord-text-header", children: incomingCall.callerName }), _jsx("p", { className: "text-[14px] text-discord-text-muted mt-1", children: "Incoming Voice Call..." })] }), _jsxs("div", { className: "flex items-center gap-6 mt-2", children: [_jsx("button", { onClick: handleDecline, className: "w-14 h-14 rounded-full bg-discord-red hover:bg-discord-red/80 flex items-center justify-center transition-colors group", title: "Decline", children: _jsx("svg", { width: "28", height: "28", viewBox: "0 0 24 24", fill: "white", className: "group-hover:scale-110 transition-transform", children: _jsx("path", { d: "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" }) }) }), _jsx("button", { onClick: handleAccept, className: "w-14 h-14 rounded-full bg-discord-green hover:bg-discord-green/80 flex items-center justify-center transition-colors group", title: "Accept", children: _jsx("svg", { width: "28", height: "28", viewBox: "0 0 24 24", fill: "white", className: "group-hover:scale-110 transition-transform", children: _jsx("path", { d: "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" }) }) })] })] })] })] }));
}
