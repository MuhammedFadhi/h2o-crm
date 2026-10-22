import { type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/api-auth";
import { getTenantId } from "@/lib/tenant";
import { apiError, apiSuccess } from "@/lib/api-response";

const UpdateWebhookSchema = z.object({
  webhook_url: z.string().url().max(2048).nullable().optional(),
  webhook_secret: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
});

/**
 * GET /api/v1/settings/outbound-webhook
 *
 * Returns the tenant's outbound webhook config. The secret is never sent
 * back in full — only whether one is set — same convention as platform
 * credentials elsewhere in the app.
 */
export async function GET(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) return apiError("UNAUTHORIZED", "Authentication required", 401);

  const supabase = createAdminClient();
  const tenantId = getTenantId();
  const { data, error } = await supabase
    .from("outbound_webhook_configs")
    .select("webhook_url, enabled, webhook_secret")
    .eq("user_id", tenantId)
    .maybeSingle<{ webhook_url: string | null; enabled: boolean; webhook_secret: string | null }>();

  if (error) return apiError("LOAD_FAILED", error.message, 500);

  return apiSuccess({
    config: {
      webhook_url: data?.webhook_url ?? null,
      enabled: data?.enabled ?? false,
      has_secret: Boolean(data?.webhook_secret),
    },
  });
}

/**
 * PUT /api/v1/settings/outbound-webhook
 *
 * Upserts the tenant's outbound webhook config. Pass only the fields you
 * want to change. Omitting webhook_secret leaves the existing one intact;
 * pass an empty string to clear it.
 */
export async function PUT(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) return apiError("UNAUTHORIZED", "Authentication required", 401);

  let parsed: z.infer<typeof UpdateWebhookSchema>;
  try {
    parsed = UpdateWebhookSchema.parse(await request.json());
  } catch (err) {
    return apiError(
      "INVALID_REQUEST",
      err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "Invalid body",
      400
    );
  }

  const supabase = createAdminClient();
  const tenantId = getTenantId();

  const { data: existing } = await supabase
    .from("outbound_webhook_configs")
    .select("webhook_secret")
    .eq("user_id", tenantId)
    .maybeSingle<{ webhook_secret: string | null }>();

  const payload: Record<string, unknown> = { user_id: tenantId };
  if (parsed.webhook_url !== undefined) payload.webhook_url = parsed.webhook_url;
  if (parsed.enabled !== undefined) payload.enabled = parsed.enabled;
  payload.webhook_secret = parsed.webhook_secret !== undefined ? parsed.webhook_secret : existing?.webhook_secret ?? null;

  const { data, error } = await supabase
    .from("outbound_webhook_configs")
    .upsert(payload, { onConflict: "user_id" })
    .select("webhook_url, enabled, webhook_secret")
    .single<{ webhook_url: string | null; enabled: boolean; webhook_secret: string | null }>();

  if (error) return apiError("SAVE_FAILED", error.message, 500);

  return apiSuccess({
    config: {
      webhook_url: data.webhook_url,
      enabled: data.enabled,
      has_secret: Boolean(data.webhook_secret),
    },
  });
}
