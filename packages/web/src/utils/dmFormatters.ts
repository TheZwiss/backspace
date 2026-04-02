/**
 * Smart timestamp for DM sidebar items.
 * Today → time ("4:32 PM"), Yesterday → "Yesterday",
 * This year → "Mar 31", Older → "Dec 14, 2025"
 */
export function formatDmTimestamp(createdAt: number): string {
  const now = new Date();
  const date = new Date(createdAt);

  // Build "start of today" and "start of yesterday" in local time
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);

  if (date >= startOfToday) {
    // Today — show time
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  if (date >= startOfYesterday) {
    return 'Yesterday';
  }

  if (date.getFullYear() === now.getFullYear()) {
    // This year — "Mar 31"
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Previous year — "Dec 14, 2025"
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
