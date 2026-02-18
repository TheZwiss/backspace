import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useUIStore } from '../../stores/uiStore';
export function ImagePreview() {
    const imageUrl = useUIStore((s) => s.imagePreviewUrl);
    const closeImagePreview = useUIStore((s) => s.closeImagePreview);
    const activeModal = useUIStore((s) => s.activeModal);
    if (activeModal !== 'imagePreview' || !imageUrl)
        return null;
    return (_jsxs("div", { className: "fixed inset-0 z-[60] flex items-center justify-center bg-discord-bg-overlay animate-fade-in cursor-pointer", onClick: closeImagePreview, children: [_jsx("button", { className: "absolute top-4 right-4 text-white/70 hover:text-white transition-colors z-10", onClick: closeImagePreview, children: _jsx("svg", { width: "24", height: "24", viewBox: "0 0 24 24", fill: "currentColor", children: _jsx("path", { d: "M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" }) }) }), _jsx("img", { src: imageUrl, alt: "Preview", className: "max-w-[90vw] max-h-[90vh] object-contain rounded shadow-elevation-high", onClick: (e) => e.stopPropagation() })] }));
}
