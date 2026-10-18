import { type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveUserId } from "@/lib/api-auth";
import { getTenantId } from "@/lib/tenant";
import { apiError, apiSuccess } from "@/lib/api-response";
import { uploadMediaBuffer } from "@/services/media.service";
import { transcodeToMp3, TranscodeError } from "@/lib/audio-transcode";
import { WhatsAppService, WhatsAppApiError } from "@/services/platforms/whatsapp/whatsapp.service";
import type { WhatsAppCredentials } from "@/services/platforms/whatsapp/whatsapp.types";

interface PlatformCredentialsRow {
  credentials: WhatsAppCredentials;
}

const IMAGE_TYPES = ["image/jpeg", "image/png"];
const DOCUMENT_TYPES = ["application/pdf"];
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * POST /api/v1/whatsapp/send-media
 *
 * Manually send an image, PDF, or voice clip to a contact from the main
 * WhatsApp tab. multipart/form-data body: to, file, caption? (images/PDFs).
 * NOTE: Only allowed inside the 24-hour customer service window.
 */
export async function POST(request: NextRequest) {
  const userId = await resolveUserId(request);
  if (!userId) {
    return apiError("UNAUTHORIZED", "Authentication required", 401);
  }

  const form = await request.formData();
  const to = form.get("to");
  const file = form.get("file");
  const caption = form.get("caption");

  if (typeof to !== "string" || !/^\+?\d{8,20}$/.test(to)) {
    return apiError("INVALID_REQUEST", "Missing or invalid 'to' phone number", 400);
  }
  if (!(file instanceof File)) {
    return apiError("INVALID_REQUEST", "Missing 'file'", 400);
  }
  if (file.size > MAX_BYTES) {
    return apiError("INVALID_REQUEST", `File too large: max ${MAX_BYTES / 1024 / 1024}MB`, 400);
  }

  const isImage = IMAGE_TYPES.includes(file.type);
  const isDocument = DOCUMENT_TYPES.includes(file.type);
  // WhatsApp accepts a wide range of audio codecs/containers (aac, m4a, amr,
  // mp3, ogg/opus, ...) with browser/OS-reported MIME types that vary a lot
  // (e.g. "audio/x-m4a"). Rather than maintain an exact allowlist, accept
  // anything the browser calls audio/* here and let Meta's API be the real
  // judge — a genuinely unsupported format comes back as a clear API error.
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
  const { data: credsRow, error: credsError } = await supabase
    .from("platform_credentials")
    .select("credentials")
    .eq("user_id", tenantId)
    .eq("platform", "whatsapp")
    .eq("is_active", true)
    .maybeSingle<PlatformCredentialsRow>();

  if (credsError || !credsRow) {
    return apiError(
      "WHATSAPP_NOT_CONNECTED",
      "Connect WhatsApp Cloud API credentials in Settings first.",
      400
    );
  }

  const wa = new WhatsAppService(credsRow.credentials);
  const contactPhone = to.startsWith("+") ? to : `+${to}`;
  const captionText = typeof caption === "string" ? caption.trim() : "";

  try {
    let buffer: Buffer = Buffer.from(await file.arrayBuffer());
    let contentType = file.type;
    if (isAudio) {
      // Normalize every audio source (browser recordings, phone voice memos,
      // etc.) to MP3 — the format proven to actually deliver for this WABA.
      // OGG/Opus voice notes were tried extensively (link and upload-by-id,
      // multiple MIME/encoding variations) and consistently rejected by
      // Meta with a "Media upload error"; see whatsapp.service.ts.
      buffer = await transcodeToMp3(buffer, contentType);
      contentType = "audio/mpeg";
    }
    const { url } = await uploadMediaBuffer(tenantId, "whatsapp-outbound", buffer, contentType);

    const result = isImage
      ? await wa.sendImageMessage(contactPhone, url, captionText || undefined)
      : isDocument
        ? await wa.sendDocumentMessage(contactPhone, url, file.name, captionText || undefined)
        : await wa.sendAudioMessage(contactPhone, url);

    const messageType = isImage ? "image" : isDocument ? "document" : "audio";
    const preview = isImage ? captionText || "📷 Image" : isDocument ? `📎 ${file.name}` : "🎙️ Audio";

    const { data: conversation } = await supabase
      .from("whatsapp_conversations")
      .upsert(
        {
          user_id: tenantId,
          contact_phone: contactPhone,
          last_message_at: new Date().toISOString(),
          last_message_preview: preview,
        },
        { onConflict: "user_id,contact_phone" }
      )
      .select("id")
      .single<{ id: string }>();

    if (conversation) {
      await supabase.from("whatsapp_messages").insert({
        conversation_id: conversation.id,
        user_id: tenantId,
        wa_message_id: result.messageId,
        direction: "outbound",
        message_type: messageType,
        body: isImage ? captionText || null : isDocument ? `📎 ${file.name}` : null,
        media_url: url,
        status: "sent",
        ai_generated: false,
        sent_at: new Date().toISOString(),
      });
    }

    return apiSuccess({ message_id: result.messageId, to: contactPhone, media_url: url });
  } catch (err) {
    if (err instanceof TranscodeError) {
      console.error("[whatsapp/send-media] Audio transcode failed", { userId, to: contactPhone, err });
      return apiError("AUDIO_TRANSCODE_FAILED", err.message, 500);
    }
    if (err instanceof WhatsAppApiError) {
      console.error("[whatsapp/send-media] Meta API rejected the send", {
        userId,
        to: contactPhone,
        statusCode: err.statusCode,
        message: err.message,
        apiError: err.apiError,
      });
      return apiError("WHATSAPP_API_ERROR", err.message, err.statusCode, err.apiError);
    }
    console.error("[whatsapp/send-media] Unexpected failure", { userId, to: contactPhone, err });
    return apiError("UNEXPECTED_ERROR", err instanceof Error ? err.message : "Unknown error", 500);
  }
}
