import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
const statusColors = {
    online: 'bg-discord-green',
    idle: 'bg-discord-yellow',
    dnd: 'bg-discord-red',
    offline: 'bg-gray-500',
};
export function Avatar({ src, name, size = 40, status, className = '', onClick }) {
    const initials = name.charAt(0).toUpperCase();
    const fontSize = size < 32 ? 'text-xs' : size < 48 ? 'text-sm' : 'text-lg';
    return (_jsxs("div", { className: `relative inline-flex flex-shrink-0 ${onClick ? 'cursor-pointer' : ''} ${className}`, style: { width: size, height: size }, onClick: onClick, children: [src ? (_jsx("img", { src: src.startsWith('http') ? src : `/api/uploads/${src}`, alt: name, className: "w-full h-full rounded-full object-cover", onError: (e) => {
                    e.target.style.display = 'none';
                    const parent = e.target.parentElement;
                    if (parent) {
                        const fallback = parent.querySelector('.avatar-fallback');
                        if (fallback)
                            fallback.style.display = 'flex';
                    }
                } })) : null, _jsx("div", { className: `avatar-fallback w-full h-full rounded-full bg-discord-blurple flex items-center justify-center ${fontSize} font-semibold text-white ${src ? 'hidden' : 'flex'}`, style: src ? { display: 'none' } : undefined, children: initials }), status && (_jsx("div", { className: `absolute -bottom-0.5 -right-0.5 rounded-full border-[3px] border-discord-bg-secondary ${statusColors[status] ?? 'bg-gray-500'}`, style: {
                    width: size * 0.35,
                    height: size * 0.35,
                    minWidth: 10,
                    minHeight: 10,
                } }))] }));
}
