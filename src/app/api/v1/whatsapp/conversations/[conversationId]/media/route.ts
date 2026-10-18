import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/api-auth";
import { getTenantId } from "@/lib/tenant";
import { apiError, apiSuccess } from "@/lib/api-response";
import { uploadMediaBuffer } from "@/services/media.service";
import { transcodeToMp3, TranscodeError } from "@/lib/audio-transcode";
import { WhatsAppService, WhatsAppApiError } from "@/services/platforms/whatsapp/whatsapp.service";
import type { WhatsAppCredentials } from "@/services/platforms/whatsapp/whatsapp.types";

interface ConvRow {
  id: string;
  contact_phone: string;
}

const IMAGE_TYPES = ["image/jpeg", "image/png"];
const DOCUMENT_TYPES = ["application/pdf"];
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * POST /api/v1/whatsapp/conversations/:conversationId/media
 *
 * Sends an image, PDF, or voice clip to the conversation's contact from the
 * Leads chat drawer. multipart/form-data body: file, caption? (images/PDFs).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> }
) {
  const userId = await resolveUserId(request);
  if (!userId) return apiError("UNAUTHORIZED", "Authentication required", 401);
  const { conversationId } = await context.params;

  const form = await request.formData();
  const file = form.get("file");
  const caption = form.get("caption");

  if (!(file instanceof File)) {
    return apiError("INVALID_REQUEST", "Missing 'file'", 400);
  }
  if (file.size > MAX_BYTES) {
    return apiError("INVALID_REQUEST", `File too large: max ${MAX_BYTES / 1024 / 1024}MB`, 400);
  }

  const isImage = IMAGE_TYPES.includes(file.type);
  const isDocument = DOCUMENT_TYPES.includes(file.type);
  // See send-media/route.ts for why audio isn't matched against a fixed list.
  const isAudio = file.type.startsWith("audio/");
  if (!isImage && !isDocument && !isAudio) {
    return apiError(
      "INVALID_REQUEST",
      `Unsupported file type: ${file.type || "(unknown)"}. Allowed: JPEG/PNG images, PDF documents, or any audio file.`,
      400
    );
  }

  const supabase = createAdminClient();
  const tenantId = getTenantId();
  const { data: conv } = await supabase
    .from("whatsapp_conversations")
    .select("id, contact_phone")
    .eq("id", conversationId)
    .eq("user_id", tenantId)
    .maybeSingle<ConvRow>();

  if (!conv) return apiError("NOT_FOUND", "Conversation not found", 404);

  const { data: credsRow } = await supabase
    .from("platform_credentials")
    .select("credentials")
    .eq("user_id", tenantId)
    .eq("platform", "whatsapp")
    .eq("is_active", true)
    .maybeSingle<{ credentials: WhatsAppCredentials }>();

  if (!credsRow) {
    return apiError("WHATSAPP_NOT_CONNECTED", "Connect WhatsApp in Settings first.", 400);
  }

  const wa = new WhatsAppService(credsRow.credentials);
  const captionText = typeof caption === "string" ? caption.trim() : "";

  try {
    let buffer: Buffer = Buffer.from(await file.arrayBuffer());
    let contentType = file.type;
    if (isAudio) {
      // See send-media/route.ts for why MP3.
      buffer = await transcodeToMp3(buffer, contentType);
      contentType = "audio/mpeg";
    }
    // Still re-host to our own storage too, for the CRM's own thread display.
    const { url } = await uploadMediaBuffer(tenantId, "whatsapp-outbound", buffer, contentType);

    const sent = isImage
      ? await wa.sendImageMessage(conv.contact_phone, url, captionText || undefined)
      : isDocument
        ? await wa.sendDocumentMessage(conv.contact_phone, url, file.name, captionText || undefined)
        : await wa.sendAudioMessage(conv.contact_phone, url);

    const messageType = isImage ? "image" : isDocument ? "document" : "audio";
    const preview = isImage ? captionText || "📷 Image" : isDocument ? `📎 ${file.name}` : "🎙️ Audio";

    const { data: message } = await supabase
      .from("whatsapp_messages")
      .insert({
        conversation_id: conv.id,
        user_id: tenantId,
        wa_message_id: sent.messageId,
        direction: "outbound",
        message_type: messageType,
        body: isImage ? captionText || null : isDocument ? `📎 ${file.name}` : null,
        media_url: url,
        status: "sent",
        ai_generated: false,
        sent_at: new Date().toISOString(),
      })
      .select("id, direction, message_type, body, media_url, ai_generated, status, sent_at, created_at")
      .single();

    await supabase
      .from("whatsapp_conversations")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: preview,
      })
      .eq("id", conv.id);

    return apiSuccess({ message });
  } catch (err) {
    if (err instanceof TranscodeError) {
      console.error("[whatsapp/conversations/media] Audio transcode failed", {
        userId,
        conversationId,
        err,
      });
      return apiError("AUDIO_TRANSCODE_FAILED", err.message, 500);
    }
    if (err instanceof WhatsAppApiError) {
      console.error("[whatsapp/conversations/media] Meta API rejected the send", {
        userId,
        conversationId,
        to: conv.contact_phone,
        statusCode: err.statusCode,
        message: err.message,
        apiError: err.apiError,
      });
      return apiError("WHATSAPP_API_ERROR", err.message, err.statusCode, err.apiError);
    }
    console.error("[whatsapp/conversations/media] Unexpected failure", {
      userId,
      conversationId,
      err,
    });
    return apiError("SEND_FAILED", err instanceof Error ? err.message : "Send failed", 500);
  }
}
