import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
export function Embed({ url }) {
    const [metadata, setMetadata] = useState(null);
    const [isLoading, setIsLoading] = useState(true);
    useEffect(() => {
        let isMounted = true;
        // Simple fetch from our new API
        fetch(`/api/utils/metadata?url=${encodeURIComponent(url)}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('opencord_token')}`
            }
        })
            .then(res => res.json())
            .then(data => {
            if (isMounted && data.title) {
                setMetadata(data);
            }
            setIsLoading(false);
        })
            .catch(() => {
            if (isMounted)
                setIsLoading(false);
        });
        return () => { isMounted = false; };
    }, [url]);
    if (isLoading || !metadata)
        return null;
    return (_jsxs("div", { className: "mt-2 max-w-[520px] bg-discord-bg-secondary rounded-[4px] border-l-4 border-discord-bg-tertiary flex overflow-hidden", children: [_jsxs("div", { className: "flex-1 p-3 min-w-0", children: [metadata.siteName && (_jsx("div", { className: "text-[12px] text-discord-text-normal font-medium mb-1 truncate", children: metadata.siteName })), metadata.title && (_jsx("a", { href: url, target: "_blank", rel: "noopener noreferrer", className: "text-[16px] text-discord-text-link font-semibold hover:underline block mb-2", children: metadata.title })), metadata.description && (_jsx("div", { className: "text-[14px] text-discord-text-normal leading-[1.125rem]", children: metadata.description }))] }), metadata.image && (_jsx("div", { className: "w-[80px] h-[80px] m-3 flex-shrink-0", children: _jsx("img", { src: metadata.image, alt: "", className: "w-full h-full object-cover rounded-[4px]" }) }))] }));
}
