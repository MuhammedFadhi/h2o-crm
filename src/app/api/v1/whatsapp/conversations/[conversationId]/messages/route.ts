import { type NextRequest } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/api-auth";
import { getTenantId } from "@/lib/tenant";
import { apiError, apiSuccess } from "@/lib/api-response";
import { WhatsAppService, WhatsAppApiError } from "@/services/platforms/whatsapp/whatsapp.service";
import type { WhatsAppCredentials } from "@/services/platforms/whatsapp/whatsapp.types";

const SendSchema = z.object({ body: z.string().min(1).max(4096) });

interface ConvRow {
  id: string;
  contact_phone: string;
  contact_name: string | null;
}

/**
 * GET /api/v1/whatsapp/conversations/:conversationId/messages
 * Returns the conversation header + messages (oldest → newest).
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> }
) {
  const userId = await resolveUserId(request);
  if (!userId) return apiError("UNAUTHORIZED", "Authentication required", 401);
  const { conversationId } = await context.params;

  const supabase = createAdminClient();
  const tenantId = getTenantId();
  const { data: conv } = await supabase
    .from("whatsapp_conversations")
    .select("id, contact_phone, contact_name")
    .eq("id", conversationId)
    .eq("user_id", tenantId)
    .maybeSingle<ConvRow>();

  if (!conv) return apiError("NOT_FOUND", "Conversation not found", 404);

  const { data: messages } = await supabase
    .from("whatsapp_messages")
    .select("id, direction, message_type, body, media_url, ai_generated, status, sent_at, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(500);

  return apiSuccess({
    channel: "whatsapp",
    contact_name: conv.contact_name,
    contact: conv.contact_phone,
    messages: messages ?? [],
  });
}

/**
 * POST /api/v1/whatsapp/conversations/:conversationId/messages
 * Sends a manual text reply to the customer and persists it.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> }
) {
  const { conversationId } = await context.params;
  const supabase = createAdminClient();
  const tenantId = getTenantId();

  // These four don't depend on each other — data scoping uses the fixed
  // shared tenantId, not the authenticated userId, so the auth check can
  // run alongside the lookups instead of blocking them.
  const [userId, rawBody, convResult, credsResult] = await Promise.all([
    resolveUserId(request),
    request.json().catch(() => null),
    supabase
      .from("whatsapp_conversations")
      .select("id, contact_phone, contact_name")
      .eq("id", conversationId)
      .eq("user_id", tenantId)
      .maybeSingle<ConvRow>(),
    supabase
      .from("platform_credentials")
      .select("credentials")
      .eq("user_id", tenantId)
      .eq("platform", "whatsapp")
      .eq("is_active", true)
      .maybeSingle<{ credentials: WhatsAppCredentials }>(),
  ]);

  if (!userId) return apiError("UNAUTHORIZED", "Authentication required", 401);

  let parsed: z.infer<typeof SendSchema>;
  try {
    parsed = SendSchema.parse(rawBody);
  } catch (err) {
    return apiError(
      "INVALID_REQUEST",
      err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : "Invalid body",
      400
    );
  }

  const conv = convResult.data;
  const credsRow = credsResult.data;
  if (!conv) return apiError("NOT_FOUND", "Conversation not found", 404);
  if (!credsRow) {
    return apiError("WHATSAPP_NOT_CONNECTED", "Connect WhatsApp in Settings first.", 400);
  }

  const wa = new WhatsAppService(credsRow.credentials);
  try {
    const sent = await wa.sendTextMessage(conv.contact_phone, parsed.body);
    const sentAt = new Date().toISOString();

    const [{ data: message }] = await Promise.all([
      supabase
        .from("whatsapp_messages")
        .insert({
          conversation_id: conv.id,
          user_id: tenantId,
          wa_message_id: sent.messageId,
          direction: "outbound",
          message_type: "text",
          body: parsed.body,
          status: "sent",
          ai_generated: false,
          sent_at: sentAt,
        })
        .select("id, direction, message_type, body, media_url, ai_generated, status, sent_at, created_at")
        .single(),
      supabase
        .from("whatsapp_conversations")
        .update({
          last_message_at: sentAt,
          last_message_preview: parsed.body.slice(0, 200),
        })
        .eq("id", conv.id),
    ]);

    return apiSuccess({ message });
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      console.error("[whatsapp/conversations/messages] Meta API rejected the send", {
        userId,
        conversationId,
        to: conv.contact_phone,
        statusCode: err.statusCode,
        message: err.message,
        apiError: err.apiError,
      });
      return apiError("WHATSAPP_API_ERROR", err.message, err.statusCode, err.apiError);
    }
    console.error("[whatsapp/conversations/messages] Unexpected failure", {
      userId,
      conversationId,
      err,
    });
    return apiError("SEND_FAILED", err instanceof Error ? err.message : "Send failed", 500);
  }
}
