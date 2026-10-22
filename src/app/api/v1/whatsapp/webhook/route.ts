import { type NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { WhatsAppService } from "@/services/platforms/whatsapp/whatsapp.service";
import { WhatsAppAutoReplyService } from "@/services/whatsapp/auto-reply.service";
import { logWhatsAppDebugEvent } from "@/lib/whatsapp-debug-log";
import type {
  WhatsAppCredentials,
  WhatsAppStatusUpdate,
  WhatsAppWebhookPayload,
} from "@/services/platforms/whatsapp/whatsapp.types";

interface PlatformCredentialsRow {
  user_id: string;
  credentials: WhatsAppCredentials;
}

/**
 * GET /api/v1/whatsapp/webhook
 *
 * Meta calls this once when you subscribe the webhook in the Meta Developer
 * Dashboard. We must echo the hub.challenge value IFF hub.verify_token matches
 * the verify_token stored in any user's credentials.
 *
 * Multiple users may have WhatsApp connected — we accept the handshake if the
 * verify_token matches ANY active WhatsApp credential row.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !token || !challenge) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const supabase = createAdminClient();
  const { data: rows, error } = await supabase
    .from("platform_credentials")
    .select("credentials")
    .eq("platform", "whatsapp")
    .eq("is_active", true);

  if (error) {
    console.error("Webhook verification: failed to query credentials", error);
    return new NextResponse("Server error", { status: 500 });
  }

  const matched = (rows ?? []).some((row) => {
    const creds = (row as { credentials?: WhatsAppCredentials }).credentials;
    return creds?.verify_token === token;
  });

  if (!matched) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Echo challenge in plain text — Meta expects body equal to hub.challenge.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * POST /api/v1/whatsapp/webhook
 *
 * Meta delivers incoming messages and status updates here.
 * Flow:
 *   1. Read raw body (REQUIRED — JSON.stringify of parsed payload won't HMAC-match).
 *   2. Look up which user this WABA belongs to (via phone_number_id in payload).
 *   3. Verify HMAC signature using that user's app_secret.
 *   4. Process each message via WhatsAppAutoReplyService.
 *
 * Returns 200 OK quickly even on errors — Meta retries non-2xx responses
 * aggressively. We log failures and move on.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. Read raw body
  const rawBody = await request.text();
  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsAppWebhookPayload;
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  if (payload.object !== "whatsapp_business_account") {
    return new NextResponse("OK", { status: 200 });
  }

  const signatureHeader = request.headers.get("x-hub-signature-256");

  console.log("[whatsapp/webhook] Received event", {
    entries: payload.entry?.length ?? 0,
    changes: payload.entry?.flatMap((e) => e.changes ?? []).length ?? 0,
  });

  // Process each entry/change
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      console.log("[whatsapp/webhook] Change payload", {
        phoneNumberId,
        messageCount: value.messages?.length ?? 0,
        statusCount: value.statuses?.length ?? 0,
        fromNumbers: value.messages?.map((m) => m.from),
      });

      // 2. Look up user via phone_number_id
      const credsRow = await lookupCredentialsByPhoneNumberId(phoneNumberId);
      if (!credsRow) {
        console.warn("WhatsApp webhook: no user found for phone_number_id", phoneNumberId);
        continue;
      }

      // 3. Verify signature using THIS user's app_secret
      const wa = new WhatsAppService(credsRow.credentials);
      if (!wa.verifyWebhookSignature(rawBody, signatureHeader)) {
        console.warn("WhatsApp webhook: invalid signature for user", credsRow.user_id, {
          phoneNumberId,
          userId: credsRow.user_id,
        });
        continue;
      }

      // 4. Process delivery/read/failed status updates for messages we sent.
      const statuses = value.statuses ?? [];
      if (statuses.length > 0) {
        await processStatusUpdates(credsRow.user_id, statuses);
      }

      // 5. Process each incoming message.
      const messages = value.messages ?? [];
      const contacts = value.contacts ?? [];
      const autoReply = new WhatsAppAutoReplyService();

      for (const message of messages) {
        const contact = contacts.find((c) => c.wa_id === message.from);
        try {
          await autoReply.processIncomingMessage(
            credsRow.user_id,
            credsRow.credentials,
            contact,
            message
          );
          console.log("[whatsapp/webhook] Inbound message processed OK", {
            userId: credsRow.user_id,
            from: message.from,
            messageId: message.id,
          });
          void logWhatsAppDebugEvent(
            "info",
            "message_received",
            `Received ${message.type} from +${message.from}.`,
            { messageId: message.id }
          );
        } catch (err) {
          console.error("WhatsApp webhook: processIncomingMessage failed", {
            userId: credsRow.user_id,
            messageId: message.id,
            err,
          });
          void logWhatsAppDebugEvent(
            "error",
            "message_processing_failed",
            `Failed to process incoming message from +${message.from}: ${err instanceof Error ? err.message : String(err)}`,
            { messageId: message.id }
          );
          // Continue processing other messages — don't bail out the whole batch.
        }
      }
    }
  }

  return new NextResponse("OK", { status: 200 });
}

/**
 * Logs each status update and persists it onto the matching outbound message
 * row so delivery failures (e.g. "failed" with a Meta error) are visible
 * instead of silently dropped.
 */
// Meta sends each status change (sent/delivered/read/failed) as a separate
// webhook request. On an edge runtime these can be processed out of order
// (no guarantee the "sent" write finishes before the "delivered" write), so
// a naive update can let an older status clobber a newer one. Only allow
// the status to move forward through this ranking — "failed" always wins.
const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 99 };

async function processStatusUpdates(
  userId: string,
  statuses: WhatsAppStatusUpdate[]
): Promise<void> {
  const supabase = createAdminClient();

  for (const status of statuses) {
    if (status.status === "failed") {
      console.error("[whatsapp/webhook] Message delivery FAILED", {
        userId,
        waMessageId: status.id,
        recipient: status.recipient_id,
        errors: status.errors,
      });
      const errText = status.errors?.map((e) => e.title || e.message).filter(Boolean).join("; ");
      void logWhatsAppDebugEvent(
        "error",
        "delivery_failed",
        `Delivery to ${status.recipient_id} failed${errText ? `: ${errText}` : "."}`,
        { waMessageId: status.id, errors: status.errors }
      );
    } else {
      console.log("[whatsapp/webhook] Message status update", {
        userId,
        waMessageId: status.id,
        status: status.status,
      });
      void logWhatsAppDebugEvent(
        "info",
        "status_update",
        `Message to ${status.recipient_id} is now "${status.status}".`
      );
    }

    const { data: existing } = await supabase
      .from("whatsapp_messages")
      .select("status")
      .eq("wa_message_id", status.id)
      .eq("user_id", userId)
      .maybeSingle<{ status: string }>();

    const incomingRank = STATUS_RANK[status.status] ?? 0;
    const currentRank = existing ? (STATUS_RANK[existing.status] ?? 0) : 0;
    if (existing && incomingRank <= currentRank) {
      // Out-of-order webhook (an older status arriving after a newer one
      // already landed) — skip so we don't regress the displayed status.
      continue;
    }

    const { error } = await supabase
      .from("whatsapp_messages")
      .update({ status: status.status })
      .eq("wa_message_id", status.id)
      .eq("user_id", userId);

    if (error) {
      console.error("[whatsapp/webhook] Failed to persist status update", {
        userId,
        waMessageId: status.id,
        error,
      });
    }
  }
}

async function lookupCredentialsByPhoneNumberId(
  phoneNumberId: string
): Promise<PlatformCredentialsRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("platform_credentials")
    .select("user_id, credentials")
    .eq("platform", "whatsapp")
    .eq("is_active", true);

  if (error || !data) return null;

  const match = data.find((row) => {
    const creds = (row as { credentials?: WhatsAppCredentials }).credentials;
    return creds?.phone_number_id === phoneNumberId;
  });

  return (match as PlatformCredentialsRow | undefined) ?? null;
}
