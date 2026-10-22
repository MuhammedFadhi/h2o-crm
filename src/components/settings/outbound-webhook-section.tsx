"use client";

import { useState, useEffect, useCallback } from "react";
import { Webhook, CheckCircle, AlertCircle, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface WebhookConfig {
  webhook_url: string | null;
  enabled: boolean;
  has_secret: boolean;
}

/**
 * Lets the user configure an outbound webhook URL that the CRM calls
 * automatically (via a Postgres trigger, not application code) whenever a
 * new lead is created or a new WhatsApp/Instagram/Messenger message
 * arrives — for pushing data into another system in real time.
 */
export function OutboundWebhookSection() {
  const [config, setConfig] = useState<WebhookConfig | null>(null);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/settings/outbound-webhook");
      const json = (await res.json()) as { success: boolean; data?: { config: WebhookConfig } };
      if (json.success && json.data) {
        setConfig(json.data.config);
        setUrl(json.data.config.webhook_url ?? "");
        setEnabled(json.data.config.enabled);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSaved(false);

    const body: Record<string, unknown> = { webhook_url: url.trim() || null, enabled };
    if (secret.trim()) body.webhook_secret = secret.trim();

    const res = await fetch("/api/v1/settings/outbound-webhook", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      success: boolean;
      data?: { config: WebhookConfig };
      error?: { message: string };
    };

    setSaving(false);
    if (!json.success || !json.data) {
      setError(json.error?.message ?? "Failed to save");
      return;
    }

    setConfig(json.data.config);
    setSecret("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-surface flex items-center justify-center">
            <Webhook size={20} strokeWidth={1.8} className="text-foreground" />
          </div>
          <div>
            <CardTitle>Outbound Webhook</CardTitle>
            <CardDescription>
              Automatically POST to another system whenever a new lead is created or a new
              message arrives on any channel.
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      {loading ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          <Input
            id="webhook-url"
            label="Webhook URL"
            placeholder="https://dev-booking.sadawater.com/api/webhooks/crm"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            error={error ?? undefined}
          />

          <Input
            id="webhook-secret"
            label="Webhook Secret (optional)"
            type="password"
            placeholder={config?.has_secret ? "•••••••• (saved — leave blank to keep)" : "Used to sign payloads"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />

          <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-border"
            />
            Enabled
          </label>

          <Button onClick={() => void handleSave()} loading={saving}>
            {saved ? (
              <>
                <CheckCircle size={14} strokeWidth={1.8} />
                Saved
              </>
            ) : (
              <>
                <Save size={14} strokeWidth={1.8} />
                Save
              </>
            )}
          </Button>

          <div className="rounded-xl border border-border bg-surface px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-foreground">What gets sent</p>
            <p className="text-xs text-text-muted leading-relaxed">
              A POST request with a JSON body: <code className="font-[family-name:var(--font-code)]">
              {"{ event, table, timestamp, data }"}</code> — <code className="font-[family-name:var(--font-code)]">event</code> is{" "}
              <code className="font-[family-name:var(--font-code)]">lead.created</code> or{" "}
              <code className="font-[family-name:var(--font-code)]">message.created</code>, and{" "}
              <code className="font-[family-name:var(--font-code)]">data</code> is the full
              inserted row. If a secret is set, the body is signed with HMAC-SHA256 (hex) in the{" "}
              <code className="font-[family-name:var(--font-code)]">X-Webhook-Signature</code> header.
            </p>
          </div>

          <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 flex gap-3 items-start">
            <AlertCircle size={15} strokeWidth={1.8} className="text-warning mt-0.5 shrink-0" />
            <p className="text-sm text-text-muted leading-relaxed">
              Fires for every new lead (any channel) and every new WhatsApp/Instagram/Messenger
              message, both inbound and outbound. Make sure your receiving endpoint can handle
              that volume.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
