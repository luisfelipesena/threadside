import { isRunning, limitResetAt, type ThreadShell } from "../connection/shell";

export function statusLabel(thread: ThreadShell): string {
  if (thread.pendingRuntimeRequest) return "Waiting for you";
  const reset = limitResetAt(thread);
  if (reset) return thread.limitRecovery?.autoResume ? `Usage limit, resumes at ${clock(reset)}` : `Usage limit until ${clock(reset)}`;
  if (isRunning(thread)) return "Working";
  const labels: Record<string, string> = {
    idle: "Ready",
    completed: "Done",
    failed: "Failed",
    interrupted: "Interrupted",
    cancelled: "Stopped",
  };
  return labels[thread.status] ?? thread.status;
}

export function relative(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)}d`;
  return `${Math.floor(seconds / (86_400 * 30))}mo`;
}

function clock(date: Date): string {
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}
