import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useRef, useEffect } from 'react';
export function Tooltip({ content, children, position = 'right', delay = 200 }) {
    const [isVisible, setIsVisible] = useState(false);
    const timeoutRef = useRef();
    const show = () => {
        timeoutRef.current = setTimeout(() => setIsVisible(true), delay);
    };
    const hide = () => {
        if (timeoutRef.current)
            clearTimeout(timeoutRef.current);
        setIsVisible(false);
    };
    useEffect(() => {
        return () => {
            if (timeoutRef.current)
                clearTimeout(timeoutRef.current);
        };
    }, []);
    const positionClasses = {
        top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
        right: 'left-full top-1/2 -translate-y-1/2 ml-2',
        bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
        left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    };
    return (_jsxs("div", { className: "relative inline-flex", onMouseEnter: show, onMouseLeave: hide, children: [children, isVisible && (_jsx("div", { className: `absolute z-50 px-3 py-1.5 text-sm font-medium text-white bg-discord-bg-floating rounded-md shadow-elevation-high whitespace-nowrap pointer-events-none ${positionClasses[position]}`, children: content }))] }));
}
