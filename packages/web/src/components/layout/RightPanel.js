import { jsx as _jsx } from "react/jsx-runtime";
import { MemberSidebar } from './MemberSidebar';
import { ActivityPanel } from './ActivityPanel';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
export function RightPanel() {
    const showDms = useUIStore((s) => s.showDms);
    const currentServerId = useServerStore((s) => s.currentServerId);
    if (showDms || !currentServerId) {
        return _jsx(ActivityPanel, {});
    }
    return _jsx(MemberSidebar, {});
}
