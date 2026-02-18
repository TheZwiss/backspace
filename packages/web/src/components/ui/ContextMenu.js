import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
export function ContextMenu({ items, children }) {
    const [isOpen, setIsOpen] = useState(false);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const menuRef = useRef(null);
    const handleContextMenu = (e) => {
        e.preventDefault();
        setPosition({ x: e.clientX, y: e.clientY });
        setIsOpen(true);
    };
    useEffect(() => {
        const handleClick = () => setIsOpen(false);
        const handleScroll = () => setIsOpen(false);
        if (isOpen) {
            document.addEventListener('click', handleClick);
            document.addEventListener('scroll', handleScroll, true);
            return () => {
                document.removeEventListener('click', handleClick);
                document.removeEventListener('scroll', handleScroll, true);
            };
        }
    }, [isOpen]);
    // Adjust position to keep menu in viewport
    useEffect(() => {
        if (isOpen && menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            const newPosition = { ...position };
            if (rect.right > window.innerWidth) {
                newPosition.x = window.innerWidth - rect.width - 8;
            }
            if (rect.bottom > window.innerHeight) {
                newPosition.y = window.innerHeight - rect.height - 8;
            }
            if (newPosition.x !== position.x || newPosition.y !== position.y) {
                setPosition(newPosition);
            }
        }
    }, [isOpen, position]);
    return (_jsxs(_Fragment, { children: [_jsx("div", { onContextMenu: handleContextMenu, children: children }), isOpen && (_jsx("div", { ref: menuRef, className: "fixed z-50 min-w-[180px] py-1.5 bg-discord-bg-floating rounded-md shadow-elevation-high animate-fade-in", style: { left: position.x, top: position.y }, children: items.map((item, i) => (_jsxs("button", { className: `w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 ${item.danger
                        ? 'text-discord-red hover:bg-discord-red hover:text-white'
                        : 'text-discord-text-secondary hover:bg-discord-blurple hover:text-white'}`, style: { width: 'calc(100% - 12px)' }, onClick: (e) => {
                        e.stopPropagation();
                        item.onClick();
                        setIsOpen(false);
                    }, children: [item.icon && _jsx("span", { className: "w-4 h-4", children: item.icon }), item.label] }, i))) }))] }));
}
