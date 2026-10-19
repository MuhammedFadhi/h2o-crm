// Always fetch fresh data — this page exists specifically to watch events live.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTenantId } from "@/lib/tenant";
import { AutoRefresh } from "@/components/whatsapp/auto-refresh";

interface DebugLogRow {
  id: string;
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  details: unknown;
  created_at: string;
}

const LEVEL_STYLES: Record<DebugLogRow["level"], string> = {
  info: "bg-surface text-text-muted border-border",
  warn: "bg-warning/10 text-warning border-warning/30",
  error: "bg-error/10 text-error border-error/30",
};

/**
 * Live-ish view of WhatsApp send attempts, delivery status, and inbound
 * webhook events — including Meta's own error details on a failed send
 * (e.g. outside the 24h window, template not approved) — so it can be
 * watched from the browser while testing instead of digging through pm2 logs.
 */
export default async function WhatsAppLogsPage() {
  const admin = createAdminClient();
  const tenantId = getTenantId();

  const { data } = await admin
    .from("whatsapp_debug_log")
    .select("id, level, event, message, details, created_at")
    .eq("user_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as DebugLogRow[];

  return (
    <div className="max-w-4xl">
      <Link
        href="/whatsapp"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-foreground mb-4 transition-colors"
      >
        <ArrowLeft size={14} strokeWidth={1.8} />
        Back to WhatsApp
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-[-0.8px] font-[family-name:var(--font-heading)] text-foreground">
          WhatsApp Send &amp; Webhook Log
        </h1>
        <p className="text-sm text-text-muted mt-1">
          Live-ish view of outbound sends, delivery status, and inbound messages — including Meta's
          own error text on a failed send. Refreshes every 2 seconds; send a message from another tab
          and watch it appear here.
        </p>
      </div>

      <AutoRefresh intervalMs={2000} />

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-elevated p-10 text-center text-sm text-text-muted">
          No events logged yet.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <LogRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function LogRow({ row }: { row: DebugLogRow }) {
  return (
    <div className={`flex items-start gap-3 px-3 py-2 rounded-lg border text-xs ${LEVEL_STYLES[row.level]}`}>
      <span className="shrink-0 font-mono text-[10px] opacity-70 mt-0.5 whitespace-nowrap">
        {formatTime(row.created_at)}
      </span>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide opacity-70 mt-0.5">
        {row.event}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words">{row.message}</p>
        {row.details != null && (
          <details className="mt-1">
            <summary className="cursor-pointer opacity-60 hover:opacity-100">details</summary>
            <pre className="mt-1 max-w-full overflow-x-auto rounded bg-background/40 p-1.5 text-[10px] whitespace-pre-wrap break-words">
              {JSON.stringify(row.details, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
