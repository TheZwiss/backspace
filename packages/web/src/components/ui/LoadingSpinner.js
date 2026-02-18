import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
export function LoadingSpinner({ size = 40, className = '' }) {
    return (_jsx("div", { className: `flex items-center justify-center ${className}`, children: _jsxs("svg", { className: "animate-spin", width: size, height: size, viewBox: "0 0 24 24", fill: "none", children: [_jsx("circle", { className: "opacity-25", cx: "12", cy: "12", r: "10", stroke: "currentColor", strokeWidth: "4" }), _jsx("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" })] }) }));
}
