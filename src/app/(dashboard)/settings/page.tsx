import { createClient } from "@/lib/supabase/server";
import { SettingsShell } from "@/components/settings/settings-shell";
import {
  PlatformCredentialsForm,
  type PlatformOAuthConnectionSummary,
} from "@/components/settings/platform-credentials-form";
import { ApiKeysForm } from "@/components/settings/api-keys-form";
import { UserApiKeysSection } from "@/components/settings/user-api-keys-section";
import { OutboundWebhookSection } from "@/components/settings/outbound-webhook-section";
import { ReplyTemplatesSection } from "@/components/settings/reply-templates-section";
import { TeamSection } from "@/components/settings/team-section";

export default async function SettingsPage() {
  const supabase = await createClient();

  // Fetch manual platform credentials and OAuth connections in parallel.
  const [credentialsResult, oauthResult, customAppsResult] = await Promise.all([
    supabase
      .from("platform_credentials")
      .select("platform, credentials, is_active"),

    supabase
      .from("platform_oauth_connections")
      .select("platform, account_title, status, token_expiry, oauth_provider, client_id_used"),

    // Custom OAuth app credentials (client_id/client_secret) are stored under
    // platform slugs like "youtube_oauth_app". We fetch all matching rows.
    supabase
      .from("platform_credentials")
      .select("platform, credentials")
      .like("platform", "%_oauth_app"),
  ]);

  const credentials = credentialsResult.data ?? [];
  const oauthRows = oauthResult.data ?? [];
  const customAppRows = customAppsResult.data ?? [];

  // Strip sensitive password-type fields before passing to client components.
  // The form receives empty strings for secrets but a `savedSecretKeys` array
  // so the UI can show "leave blank to keep saved value" placeholders without
  // ever leaking actual secrets to the browser.
  const PASSWORD_FIELD_KEYS = new Set([
    "access_token",
    "page_access_token",
    "app_secret",
    "client_secret",
    "api_key",
    "secret",
    "password",
  ]);

  const maskedCredentials = credentials.map((c) => {
    const creds = (c.credentials ?? {}) as Record<string, string>;
    const safeCreds: Record<string, string> = {};
    const savedSecretKeys: string[] = [];

    for (const [key, value] of Object.entries(creds)) {
      if (PASSWORD_FIELD_KEYS.has(key)) {
        // Strip secret entirely; remember it existed
        safeCreds[key] = "";
        if (typeof value === "string" && value.trim()) {
          savedSecretKeys.push(key);
        }
      } else {
        safeCreds[key] = value;
      }
    }

    return {
      platform: c.platform as string,
      credentials: safeCreds,
      savedSecretKeys,
      is_active: c.is_active as boolean,
    };
  });

  // Build OAuth connection summaries. These are safe to pass to the client —
  // they contain no tokens, only display metadata.
  const oauthConnections: PlatformOAuthConnectionSummary[] = oauthRows.map((row) => ({
    platform: row.platform as string,
    accountTitle: row.account_title as string,
    status: row.status as "active" | "expired" | "disconnected",
    tokenExpiry: row.token_expiry as string | null,
    oauthProvider: row.oauth_provider as "system" | "custom",
    clientIdUsed: row.client_id_used as string,
  }));

  // Build custom OAuth app credentials map.
  // client_secret is NEVER sent to the browser — only a boolean indicating it exists.
  const customOAuthApps: Record<string, { client_id?: string; has_client_secret: boolean }> = {};
  for (const row of customAppRows) {
    const creds = (row.credentials ?? {}) as Record<string, string>;
    customOAuthApps[row.platform as string] = {
      client_id: creds.client_id ?? undefined,
      has_client_secret: Boolean(creds.client_secret?.trim()),
    };
  }

  const initialApiKeyConfigured: Record<string, boolean> = {
    openrouter: credentials.some(
      (c) => c.platform === "openrouter" && c.is_active === true
    ),
  };

  return (
    <div className="max-w-6xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-[-0.8px] font-[family-name:var(--font-heading)] text-foreground">
          Settings
        </h1>
        <p className="text-sm text-text-muted mt-1">
          Manage your account, connected platforms, and API keys
        </p>
      </div>

      <SettingsShell
        platformsContent={
          <PlatformCredentialsForm
            initialCredentials={maskedCredentials}
            oauthConnections={oauthConnections}
            customOAuthApps={customOAuthApps}
          />
        }
        apiKeysContent={
          <div className="space-y-6">
            <ApiKeysForm initialConfigured={initialApiKeyConfigured} />
            <UserApiKeysSection />
            <OutboundWebhookSection />
          </div>
        }
        quickRepliesContent={<ReplyTemplatesSection />}
        teamContent={<TeamSection />}
      />
    </div>
  );
}
