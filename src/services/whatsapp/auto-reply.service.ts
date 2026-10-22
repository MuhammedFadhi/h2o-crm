import { createAdminClient } from "@/lib/supabase/admin";
import { generateOpenRouterJsonResponse } from "@/lib/openrouter";
import { uploadMediaBuffer } from "@/services/media.service";
import { WhatsAppService, WhatsAppApiError } from "@/services/platforms/whatsapp/whatsapp.service";
import {
  DEFAULT_WHATSAPP_SIGNATURE_SUFFIX,
  DEFAULT_WHATSAPP_SYSTEM_PROMPT,
  WHATSAPP_AI_JSON_CONTRACT,
} from "@/services/platforms/whatsapp/whatsapp.constants";
import {
  buildBookingFreeText,
  formatBookingDate,
  formatBookingTime,
  type BookingMessageFields,
} from "@/services/booking/booking.constants";
import type {
  WhatsAppAIDecision,
  WhatsAppCredentials,
  WhatsAppIncomingMessage,
  WhatsAppContact,
} from "@/services/platforms/whatsapp/whatsapp.types";

interface WhatsAppAutomationConfigRow {
  enabled: boolean;
  auto_reply: boolean;
  system_prompt: string;
  signature_suffix: string;
  business_hours_enabled: boolean;
  business_hours_start: string | null;
  business_hours_end: string | null;
  business_hours_timezone: string | null;
  out_of_hours_message: string | null;
  product_images: Record<string, string> | null;
}

const PRODUCT_IMAGE_LABELS: Record<string, string> = {
  dispenser:     "RO Water Dispenser (Hot/Cold) — SAR 499",
  ro_699:        "7-Stage RO Purifier — SAR 699",
  ro_uv_999:     "7-Stage RO Purifier + UV — SAR 999",
  smart_ro_1199: "6-Stage Smart RO — SAR 1,199",
  smart_ro_1299: "7-Stage Smart RO — SAR 1,299",
};

function buildProductImageSection(images: Record<string, string>): string {
  const entries = Object.entries(images).filter(([, url]) => typeof url === "string" && url.startsWith("http"));
  if (entries.length === 0) return "";

  const lines = entries.map(([slug, url]) => {
    const label = PRODUCT_IMAGE_LABELS[slug] ?? slug;
    return `• ${label}: ${url}`;
  });

  return `\n\n=== PRODUCT IMAGE URLS (auto-injected — use ONLY these, never invent URLs) ===
You CAN send images on WhatsApp. When a customer asks for photos or pictures of any product:
- Add the relevant image URL(s) to the images_to_send JSON field
- Do NOT say "I'm unable to send images"
- If they ask for ALL products, include all URLs below
- If they ask for a specific model, include only that model's URL

${lines.join("\n")}`;
}

interface PlatformCredentialsRow {
  credentials: {
    api_key?: string;
  };
}

/**
 * Handles an incoming WhatsApp message end-to-end:
 *   1. Upserts the conversation row.
 *   2. Persists the inbound message.
 *   3. If automation is enabled, generates an AI reply via OpenRouter.
 *   4. Sends the reply via Cloud API (if auto_reply is on).
 *   5. Persists the outbound message + updates conversation aggregate.
 *
 * Handles business-hours logic and skips spam intents.
 */
export class WhatsAppAutoReplyService {
  /**
   * Process one inbound WhatsApp message for a given user.
   * Returns the AI decision summary for logging / API responses.
   */
  async processIncomingMessage(
    userId: string,
    credentials: WhatsAppCredentials,
    contact: WhatsAppContact | undefined,
    message: WhatsAppIncomingMessage
  ): Promise<{
    conversationId: string;
    inboundMessageId: string;
    aiDecision: WhatsAppAIDecision | null;
    outboundMessageId: string | null;
    skippedReason: string | null;
  }> {
    const supabase = createAdminClient();
    const wa = new WhatsAppService(credentials);

    // 1. Upsert conversation
    const contactPhone = `+${message.from}`;
    const contactName = contact?.profile?.name ?? null;
    const messagePreview = extractMessagePreview(message);

    const { data: conversation, error: convError } = await supabase
      .from("whatsapp_conversations")
      .upsert(
        {
          user_id: userId,
          contact_phone: contactPhone,
          contact_name: contactName,
          last_message_at: new Date(Number(message.timestamp) * 1000).toISOString(),
          last_message_preview: messagePreview.slice(0, 200),
        },
        { onConflict: "user_id,contact_phone" }
      )
      .select("id, ai_paused")
      .single<{ id: string; ai_paused: boolean }>();

    if (convError || !conversation) {
      throw new Error(`Failed to upsert WhatsApp conversation: ${convError?.message}`);
    }

    // 2. Persist inbound message
    const mediaUrl = await downloadInboundMedia(wa, userId, message);
    // Meta marks a real recorded voice note with audio.voice === true; a
    // regular shared audio file (e.g. a song) has voice === false and gets
    // its own type so it renders as a plain player, not the voice-note UI.
    const messageType =
      message.type === "audio" && message.audio?.voice === false ? "audio_file" : message.type;
    const { data: inbound, error: inboundError } = await supabase
      .from("whatsapp_messages")
      .insert({
        conversation_id: conversation.id,
        user_id: userId,
        wa_message_id: message.id,
        direction: "inbound",
        message_type: messageType,
        body: messagePreview || null,
        media_url: mediaUrl,
        status: "received",
        raw_payload: message,
        sent_at: new Date(Number(message.timestamp) * 1000).toISOString(),
      })
      .select("id")
      .single<{ id: string }>();

    if (inboundError || !inbound) {
      // If unique constraint hits (duplicate webhook), don't crash — just skip.
      if (inboundError?.code === "23505") {
        return {
          conversationId: conversation.id,
          inboundMessageId: "duplicate",
          aiDecision: null,
          outboundMessageId: null,
          skippedReason: "duplicate_webhook",
        };
      }
      throw new Error(`Failed to persist inbound message: ${inboundError?.message}`);
    }

    // NOTE: read-receipt ("blue ticks") is intentionally NOT sent here on
    // arrival — only right alongside an actual reply (see markInboundRead()
    // calls below), so the customer doesn't see "read" with no response if
    // the AI/business ends up not replying at all.

    // Ensure every inbound conversation has a lead (status 'new') with its
    // source flag, so ALL chats appear in the Leads list immediately — not
    // only after qualification or a manual convert. Non-blocking.
    try {
      await this.ensureLeadForConversation(userId, conversation.id, contactPhone, contactName, messagePreview);
    } catch (err) {
      console.error("ensureLeadForConversation (WhatsApp) failed", err);
    }

    // 3a. Short-circuit if AI is paused for this specific conversation.
    // The message is already stored — only the AI reply is skipped so a
    // human can take over from the dashboard.
    if (conversation.ai_paused) {
      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: null,
        outboundMessageId: null,
        skippedReason: "ai_paused_for_conversation",
      };
    }

    // 3. Load automation config — short-circuit if disabled
    const config = await this.getConfig(userId);
    if (!config.enabled || !config.auto_reply) {
      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: null,
        outboundMessageId: null,
        skippedReason: !config.enabled ? "automation_disabled" : "auto_reply_disabled",
      };
    }

    // 4. Business hours check
    if (config.business_hours_enabled && !isWithinBusinessHours(config)) {
      // Send out-of-hours message if configured
      if (config.out_of_hours_message?.trim()) {
        try {
          this.markInboundRead(wa, message.id);
          const sent = await wa.sendTextMessage(contactPhone, config.out_of_hours_message);
          await this.persistOutboundMessage(supabase, {
            conversationId: conversation.id,
            userId,
            waMessageId: sent.messageId,
            body: config.out_of_hours_message,
            aiGenerated: false,
          });
        } catch (err) {
          console.error("Failed to send out-of-hours message", err);
        }
      }
      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: null,
        outboundMessageId: null,
        skippedReason: "out_of_hours",
      };
    }

    // 5. Get AI decision
    if (message.type !== "text" || !message.text?.body) {
      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: null,
        outboundMessageId: null,
        skippedReason: "non_text_message",
      };
    }

    // Burst-message coalescing: when a customer sends several messages in quick
    // succession (e.g. "Hi" → "2" → "1"), each webhook fires a parallel handler.
    // Wait 1.5 s then check whether a newer inbound message has arrived for this
    // conversation — if so, skip AI generation here and let the newer handler win.
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));

    const { data: newerMessages } = await createAdminClient()
      .from("whatsapp_messages")
      .select("id")
      .eq("conversation_id", conversation.id)
      .eq("direction", "inbound")
      .neq("id", inbound.id)
      .gt("created_at", new Date(Number(message.timestamp) * 1000).toISOString())
      .limit(1);

    if (newerMessages && newerMessages.length > 0) {
      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: null,
        outboundMessageId: null,
        skippedReason: "superseded_by_newer_message",
      };
    }

    const apiKey = await this.getOpenRouterApiKey(userId);
    const history = await this.fetchConversationHistory(conversation.id, inbound.id);

    // Append product image URLs to the system prompt dynamically so the bot
    // can send images without the user having to paste URLs manually.
    const basePrompt = config.system_prompt || DEFAULT_WHATSAPP_SYSTEM_PROMPT;
    const imageSection = buildProductImageSection(config.product_images ?? {});
    const fullPrompt = basePrompt + imageSection;

    // Load the customer's active booking (if any) so the AI can interpret
    // reschedule requests against it.
    const booking = await this.getActiveBooking(userId, conversation.id);

    const activeBookingInfo = booking
      ? `Ref ${booking.booking_ref}, installation ${formatBookingDate(booking.scheduled_at)} at ${
          booking.slot_label?.trim() || formatBookingTime(booking.scheduled_at)
        }`
      : null;

    const decision = await this.getAIDecision(
      fullPrompt,
      contactName,
      message.text.body,
      config.signature_suffix || DEFAULT_WHATSAPP_SIGNATURE_SUFFIX,
      history,
      apiKey,
      formatRiyadhNow(),
      booking?.pending_reschedule_at ?? null,
      activeBookingInfo
    );

    // 5b. Reschedule flow (confirm-first). Handles propose / confirm / cancel
    // against the active booking and short-circuits the normal reply.
    if (booking) {
      const handled = await this.handleRescheduleIfAny(supabase, wa, {
        conversationId: conversation.id,
        contactPhone,
        contactName,
        userId,
        booking,
        decision,
        customerText: message.text.body,
        inboundMessageId: message.id,
      });
      if (handled) {
        return {
          conversationId: conversation.id,
          inboundMessageId: inbound.id,
          aiDecision: decision,
          outboundMessageId: handled.outboundId,
          skippedReason: null,
        };
      }
    }

    // 6. Send reply if AI decided yes
    const replyText = decision.reply?.trim() ?? "";
    const hasImages = Array.isArray(decision.images_to_send) && decision.images_to_send.length > 0;
    // Skip if AI said no-reply AND there are no images to send
    if (!decision.should_reply && !hasImages) {
      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: decision,
        outboundMessageId: null,
        skippedReason: "ai_decided_skip",
      };
    }
    // Guard against junk single-character replies like "?" — skip text but still send images
    const isJunkReply = replyText.length <= 2 && !/^(ok|hi)$/i.test(replyText);
    if (!replyText && !hasImages) {
      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: decision,
        outboundMessageId: null,
        skippedReason: "empty_reply",
      };
    }

    try {
      // We're about to actually reply (text and/or images) — ack read now.
      this.markInboundRead(wa, message.id);

      // 6a. Send product images BEFORE the text reply (if AI included any)
      const imageUrls = Array.isArray(decision.images_to_send)
        ? decision.images_to_send.filter((u): u is string => typeof u === "string" && u.startsWith("http"))
        : [];

      for (const imageUrl of imageUrls) {
        try {
          await wa.sendImageMessage(contactPhone, imageUrl);
        } catch (imgErr) {
          console.warn("Failed to send product image (non-blocking)", { imageUrl, err: imgErr });
        }
      }

      // 6b. Skip text reply if it's junk (single char like "?") but images were sent
      if (isJunkReply || !replyText) {
        if (imageUrls.length > 0) {
          console.warn("Skipped junk text reply after sending images", { reply: replyText });
        }
        return {
          conversationId: conversation.id,
          inboundMessageId: inbound.id,
          aiDecision: decision,
          outboundMessageId: null,
          skippedReason: isJunkReply ? "junk_reply_suppressed" : "empty_reply",
        };
      }

      const sent = await wa.sendTextMessage(contactPhone, replyText);
      const outboundId = await this.persistOutboundMessage(supabase, {
        conversationId: conversation.id,
        userId,
        waMessageId: sent.messageId,
        body: replyText,
        aiGenerated: true,
      });

      // Auto-create lead when AI says the qualification is complete.
      // We accept two signals:
      //   1. Explicit lead_ready=true in the AI's JSON response (the cleanest)
      //   2. Fallback heuristic — the reply contains the summary phrase
      //      "team will contact you" (in case the AI forgot the JSON flag
      //      but still sent the right reply text)
      const replyLooksLikeSummary =
        /our team will contact you/i.test(replyText) ||
        /our team will reach out/i.test(replyText) ||
        /team will get in touch/i.test(replyText);
      // Never re-run lead qualification for a customer who already has a
      // booking — it would regress the lead from 'scheduled' back to 'qualified'.
      const shouldCreateLead =
        !booking && (decision.lead_ready === true || replyLooksLikeSummary);

      // Always log what we got so debugging is easy from pm2 logs
      console.log("WhatsApp AI decision summary", {
        conversationId: conversation.id,
        contactPhone,
        shouldCreateLead,
        lead_ready_flag: decision.lead_ready,
        reply_matches_summary_pattern: replyLooksLikeSummary,
        has_lead_data: !!decision.lead_data,
        lead_data: decision.lead_data,
      });

      if (shouldCreateLead) {
        try {
          await this.maybeCreateLeadFromAI(
            userId,
            conversation.id,
            contactPhone,
            contactName,
            decision.lead_data ?? {},
            replyText
          );
          console.log("Auto-create lead succeeded", {
            conversationId: conversation.id,
          });
        } catch (leadErr) {
          // Don't fail the reply just because lead creation failed
          console.error("Auto-create lead FAILED", {
            conversationId: conversation.id,
            err: leadErr instanceof Error ? leadErr.message : leadErr,
          });
        }
      }

      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: decision,
        outboundMessageId: outboundId,
        skippedReason: null,
      };
    } catch (err) {
      const reason = err instanceof WhatsAppApiError ? err.message : "send_failed";
      console.error("Failed to send WhatsApp AI reply", { contactPhone, err });
      return {
        conversationId: conversation.id,
        inboundMessageId: inbound.id,
        aiDecision: decision,
        outboundMessageId: null,
        skippedReason: reason,
      };
    }
  }

  /**
   * Creates a 'new' lead for a conversation on its first inbound message, if one
   * doesn't already exist. Later qualification fills in the details.
   */
  private async ensureLeadForConversation(
    userId: string,
    conversationId: string,
    contactPhone: string,
    contactName: string | null,
    preview: string
  ): Promise<void> {
    const supabase = createAdminClient();
    const { data: existing } = await supabase
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .eq("whatsapp_conversation_id", conversationId)
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (existing) return;

    const { data: nextNoData } = await supabase
      .rpc("next_lead_serial_no", { p_user_id: userId })
      .single<number>();
    const serial_no = typeof nextNoData === "number" ? nextNoData : 1;

    await supabase.from("leads").insert({
      user_id: userId,
      serial_no,
      client_name: contactName?.trim() || contactPhone,
      client_phone: contactPhone,
      status: "new",
      call_status: "unread",
      source: "whatsapp_ai",
      whatsapp_conversation_id: conversationId,
      remarks: preview?.slice(0, 200) || null,
    });
  }

  /**
   * Auto-creates (or updates) a lead row from the AI's extracted lead_data
   * when the qualification flow is complete. If a lead already exists for
   * this conversation, fills in any missing fields without overwriting
   * data the operator may have already corrected manually.
   */
  private async maybeCreateLeadFromAI(
    userId: string,
    conversationId: string,
    contactPhone: string,
    contactName: string | null,
    leadData: {
      client_name?: string | null;
      business_type?: string | null;
      location_text?: string | null;
      product_model?: string | null;
      product_qty?: number | null;
      remarks?: string | null;
    },
    replyText: string = ""
  ): Promise<void> {
    const supabase = createAdminClient();

    // If lead_data is missing fields, try to extract them from the AI's summary
    // text using simple heuristics (the AI usually mentions the model + qty +
    // location right in the reply).
    if (!leadData.product_model) {
      const modelMatch = replyText.match(
        /\*?(7-Stage Smart RO|6-Stage Smart RO|7-Stage RO \+ UV|7-Stage RO|Dispenser \(Hot\/Cold\))\*?/i
      );
      if (modelMatch) leadData.product_model = modelMatch[1];
    }
    if (!leadData.product_qty) {
      const qtyMatch = replyText.match(/×\s*(\d+)/);
      if (qtyMatch) leadData.product_qty = parseInt(qtyMatch[1], 10);
    }
    if (!leadData.business_type) {
      const lowered = replyText.toLowerCase();
      if (/for your home|for home|residential/.test(lowered)) leadData.business_type = "Home / Residential";
      else if (/coffee shop/.test(lowered)) leadData.business_type = "Coffee shop";
      else if (/restaurant/.test(lowered)) leadData.business_type = "Restaurant";
      else if (/office/.test(lowered)) leadData.business_type = "Office";
      else if (/hotel/.test(lowered)) leadData.business_type = "Hotel";
    }
    if (!leadData.location_text) {
      // Pattern: "in <CITY>" or "in <PLACE>" in the summary
      const locMatch = replyText.match(/(?:in|at)\s+([A-Z][\wÀ-ÿ\s'.-]+?)(?:[•\n.!?]|$)/);
      if (locMatch) leadData.location_text = locMatch[1].trim();
    }

    // Look for a Google Maps URL in the conversation's location messages
    // — the AI doesn't see the raw payload, only "📍 Location" placeholders.
    let googleMapsUrl: string | null = null;
    let lat: number | null = null;
    let lng: number | null = null;
    const { data: locationRows } = await supabase
      .from("whatsapp_messages")
      .select("raw_payload")
      .eq("conversation_id", conversationId)
      .eq("message_type", "location")
      .order("created_at", { ascending: false })
      .limit(1);

    if (locationRows && locationRows.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = locationRows[0].raw_payload as any;
      const loc = payload?.location;
      if (loc) {
        if (typeof loc.latitude === "number") lat = loc.latitude;
        if (typeof loc.longitude === "number") lng = loc.longitude;
        if (lat !== null && lng !== null) {
          googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
        }
      }
    }

    // Does a lead for this conversation already exist?
    const { data: existing } = await supabase
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .eq("whatsapp_conversation_id", conversationId)
      .limit(1)
      .maybeSingle<{ id: string }>();

    const clientName =
      leadData.client_name?.trim() ||
      contactName?.trim() ||
      contactPhone;

    if (existing) {
      // Update only fields that are still empty (don't clobber operator edits)
      const updatePayload: Record<string, unknown> = {};
      if (leadData.business_type) updatePayload.client_business_type = leadData.business_type;
      if (leadData.location_text) updatePayload.location_address = leadData.location_text;
      if (leadData.product_model) updatePayload.product_model = leadData.product_model;
      if (typeof leadData.product_qty === "number") updatePayload.product_qty = leadData.product_qty;
      if (leadData.remarks) updatePayload.remarks = leadData.remarks;
      if (googleMapsUrl) updatePayload.location_url = googleMapsUrl;
      if (lat !== null) updatePayload.location_lat = lat;
      if (lng !== null) updatePayload.location_lng = lng;
      updatePayload.status = "qualified";

      if (Object.keys(updatePayload).length > 0) {
        await supabase
          .from("leads")
          .update(updatePayload)
          .eq("id", existing.id);
      }
      return;
    }

    // Create new lead
    const { data: nextNoData } = await supabase
      .rpc("next_lead_serial_no", { p_user_id: userId })
      .single<number>();
    const serial_no = typeof nextNoData === "number" ? nextNoData : 1;

    await supabase.from("leads").insert({
      user_id: userId,
      serial_no,
      client_name: clientName,
      client_phone: contactPhone,
      client_business_type: leadData.business_type ?? null,
      product_qty: leadData.product_qty ?? 1,
      product_model: leadData.product_model ?? null,
      location_address: leadData.location_text ?? null,
      location_url: googleMapsUrl,
      location_lat: lat,
      location_lng: lng,
      status: "qualified",
      call_status: "unread",
      source: "whatsapp_ai",
      whatsapp_conversation_id: conversationId,
      remarks: leadData.remarks ?? null,
    });
  }

  /**
   * Loads the user's automation config or returns safe defaults.
   */
  private async getConfig(userId: string): Promise<WhatsAppAutomationConfigRow> {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("whatsapp_automation_configs")
      .select(
        "enabled, auto_reply, system_prompt, signature_suffix, business_hours_enabled, business_hours_start, business_hours_end, business_hours_timezone, out_of_hours_message, product_images"
      )
      .eq("user_id", userId)
      .maybeSingle<WhatsAppAutomationConfigRow>();

    return (
      data ?? {
        enabled: false,
        auto_reply: false,
        system_prompt: DEFAULT_WHATSAPP_SYSTEM_PROMPT,
        signature_suffix: DEFAULT_WHATSAPP_SIGNATURE_SUFFIX,
        business_hours_enabled: false,
        business_hours_start: null,
        business_hours_end: null,
        business_hours_timezone: null,
        out_of_hours_message: null,
        product_images: null,
      }
    );
  }

  private async getOpenRouterApiKey(userId: string): Promise<string | undefined> {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("platform_credentials")
      .select("credentials")
      .eq("user_id", userId)
      .eq("platform", "openrouter")
      .maybeSingle<PlatformCredentialsRow>();

    return data?.credentials?.api_key;
  }

  /**
   * Fetches the last N messages of a conversation (oldest → newest) to use
   * as conversation history for the LLM. Excludes the just-inserted inbound
   * message (which we pass separately as the current userMessage).
   */
  private async fetchConversationHistory(
    conversationId: string,
    currentInboundId: string,
    limit: number = 15
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("whatsapp_messages")
      .select("id, direction, body")
      .eq("conversation_id", conversationId)
      .neq("id", currentInboundId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (!data) return [];

    return data
      .filter((m) => typeof m.body === "string" && m.body.trim().length > 0)
      .map((m) => ({
        role: m.direction === "inbound" ? ("user" as const) : ("assistant" as const),
        content: m.body as string,
      }));
  }

  private async getAIDecision(
    systemPrompt: string,
    contactName: string | null,
    message: string,
    signatureSuffix: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    apiKey?: string,
    currentDateTime?: string,
    pendingRescheduleAt?: string | null,
    activeBookingInfo?: string | null
  ): Promise<WhatsAppAIDecision> {
    // LLM_MODEL is the new generic name. OPENROUTER_CLAUDE_MODEL kept for back-compat.
    // Defaults to a cheap, capable OpenAI model so works out-of-the-box with OPENAI_API_KEY.
    const model =
      process.env.LLM_MODEL ??
      process.env.OPENROUTER_CLAUDE_MODEL ??
      "gpt-4o-mini";
    const fullSystemPrompt = systemPrompt.trimEnd() + WHATSAPP_AI_JSON_CONTRACT;

    const decision = await generateOpenRouterJsonResponse<WhatsAppAIDecision>({
      model,
      systemPrompt: fullSystemPrompt,
      apiKey,
      history,
      userMessage: JSON.stringify({
        contact_name: contactName ?? "",
        message,
        current_datetime: currentDateTime ?? null,
        pending_reschedule_at: pendingRescheduleAt ?? null,
        active_booking: activeBookingInfo ?? null,
      }),
    });

    const finalReply = appendSignatureIfPresent(decision.reply, signatureSuffix);

    const rIntent = decision.reschedule?.intent;
    const reschedule: WhatsAppAIDecision["reschedule"] = {
      intent:
        rIntent === "propose" || rIntent === "confirm" || rIntent === "cancel"
          ? rIntent
          : "none",
      new_datetime_iso: decision.reschedule?.new_datetime_iso ?? null,
    };

    return {
      should_reply: Boolean(decision.should_reply),
      reply: finalReply,
      intent: decision.intent ?? null,
      lead_ready: decision.lead_ready ?? false,
      lead_data: decision.lead_data ?? {},
      images_to_send: Array.isArray(decision.images_to_send) ? decision.images_to_send : [],
      reschedule,
    };
  }

  /**
   * Loads the active (non-cancelled) booking for the lead linked to this
   * WhatsApp conversation, or null. Used by the reschedule flow.
   */
  private async getActiveBooking(
    userId: string,
    conversationId: string
  ): Promise<{
    id: string;
    lead_id: string;
    scheduled_at: string;
    pending_reschedule_at: string | null;
    booking_ref: string;
    product_snapshot: string | null;
    qty_snapshot: number;
    total_amount: number | null;
    currency: string;
    slot_label: string | null;
    technician_id: string | null;
    slot_id: string | null;
  } | null> {
    const supabase = createAdminClient();
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("user_id", userId)
      .eq("whatsapp_conversation_id", conversationId)
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (!lead) return null;

    const { data: booking } = await supabase
      .from("bookings")
      .select(
        "id, lead_id, scheduled_at, pending_reschedule_at, booking_ref, product_snapshot, qty_snapshot, total_amount, currency, slot_label, technician_id, slot_id"
      )
      .eq("user_id", userId)
      .eq("lead_id", lead.id)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (booking as any) ?? null;
  }

  /** Open (unbooked) slots for a technician on a date, ordered by start time. */
  private async getOpenSlots(
    userId: string,
    technicianId: string,
    date: string
  ): Promise<Array<{ id: string; start_time: string; end_time: string }>> {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("technician_slots")
      .select("id, start_time, end_time")
      .eq("user_id", userId)
      .eq("technician_id", technicianId)
      .eq("slot_date", date)
      .is("booking_id", null)
      .order("start_time", { ascending: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data as any) ?? [];
  }

  /** Claims a free slot for a booking (race-safe). */
  private async claimSlotInline(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    userId: string,
    slotId: string,
    bookingId: string
  ): Promise<boolean> {
    const { data } = await supabase
      .from("technician_slots")
      .update({ booking_id: bookingId })
      .eq("id", slotId)
      .eq("user_id", userId)
      .is("booking_id", null)
      .select("id");
    return Array.isArray(data) && data.length > 0;
  }

  /** Releases a slot back to the open pool. */
  private async freeSlotInline(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    userId: string,
    slotId: string
  ): Promise<void> {
    await supabase
      .from("technician_slots")
      .update({ booking_id: null })
      .eq("id", slotId)
      .eq("user_id", userId);
  }

  /**
   * Slot-aware reschedule proposal: matches the customer's requested time to an
   * open slot for the booking's technician. Sets pending if matched; otherwise
   * offers the open slots (or says the day is full). Returns the reply text.
   */
  private async proposeSlotReschedule(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    booking: any,
    iso: string
  ): Promise<string> {
    const { date, hhmm } = riyadhDateAndTime(iso);
    const open = await this.getOpenSlots(userId, booking.technician_id, date);
    const match = open.find((s) => String(s.start_time).slice(0, 5) === hhmm);

    if (match) {
      await supabase.from("bookings").update({ pending_reschedule_at: iso }).eq("id", booking.id);
      return `📅 I can move your SA'DA H2O installation to *${formatBookingDate(iso)} at ${fmtSlotTime(
        match.start_time
      )}–${fmtSlotTime(match.end_time)}*.\n\nReply *YES* to confirm.`;
    }

    await supabase.from("bookings").update({ pending_reschedule_at: null }).eq("id", booking.id);
    if (open.length) {
      return `That time isn't available on *${formatBookingDate(
        iso
      )}*.\n\nOpen slots: ${formatSlotList(open)}.\n\nReply with one of these times.`;
    }
    return `We're fully booked on *${formatBookingDate(iso)}* 😔 Could you try another day?`;
  }

  /**
   * Slot-aware confirm: re-resolves the pending slot, claims it (race-safe),
   * frees the old slot, and updates the booking. Returns the reply text.
   */
  private async confirmSlotReschedule(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    userId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    booking: any,
    contactName: string | null,
    contactPhone: string
  ): Promise<string> {
    const p = booking.pending_reschedule_at as string;
    const { date, hhmm } = riyadhDateAndTime(p);
    const open = await this.getOpenSlots(userId, booking.technician_id, date);
    const match = open.find((s) => String(s.start_time).slice(0, 5) === hhmm);

    const cannot = async (): Promise<string> => {
      await supabase.from("bookings").update({ pending_reschedule_at: null }).eq("id", booking.id);
      return open.length
        ? `Sorry, that slot was just taken. On *${formatBookingDate(p)}* I now have: ${formatSlotList(
            open
          )}. Which works?`
        : `Sorry, that slot was just taken and we're now full on *${formatBookingDate(
            p
          )}*. Could you pick another day?`;
    };

    if (!match) return cannot();
    const claimed = await this.claimSlotInline(supabase, userId, match.id, booking.id);
    if (!claimed) return cannot();
    if (booking.slot_id) await this.freeSlotInline(supabase, userId, booking.slot_id);

    const slotLabel = `${fmtSlotTime(match.start_time)}–${fmtSlotTime(match.end_time)}`;
    await supabase
      .from("bookings")
      .update({ scheduled_at: p, slot_id: match.id, slot_label: slotLabel, pending_reschedule_at: null })
      .eq("id", booking.id);
    await supabase
      .from("leads")
      .update({ installation_date: p.slice(0, 10) })
      .eq("id", booking.lead_id);

    return buildBookingFreeText(rescheduleFields(booking, p, contactName, contactPhone, slotLabel));
  }

  /**
   * Confirm-first reschedule handling. Returns { outboundId } if it sent a
   * reschedule-related reply (and the caller should stop), or null to let the
   * normal reply flow continue.
   */
  private async handleRescheduleIfAny(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    wa: WhatsAppService,
    params: {
      conversationId: string;
      contactPhone: string;
      contactName: string | null;
      userId: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      booking: any;
      decision: WhatsAppAIDecision;
      customerText: string;
      inboundMessageId: string;
    }
  ): Promise<{ outboundId: string } | null> {
    const { booking, decision, contactPhone, contactName, conversationId, userId, inboundMessageId } = params;
    const intent = decision.reschedule?.intent ?? "none";
    const text = params.customerText.trim();
    const newIso = decision.reschedule?.new_datetime_iso ?? null;
    const affirmative = /^\s*(yes|yep|yeah|ok|okay|okey|confirm|sure|نعم|تمام|اوكي|أوكي|اوك)\b/i.test(text);
    const negative = /^\s*(no|nope|cancel|keep|لا|كنسل|الغاء|إلغاء)\b/i.test(text);
    const hasPending = Boolean(booking.pending_reschedule_at);
    // Slot-aware when the booking has an assigned technician; otherwise fall back
    // to the legacy free-time behaviour (older bookings with no technician).
    const slotAware = Boolean(booking.technician_id);

    const stays = () =>
      `No problem 👍 Your installation stays on *${formatBookingDate(booking.scheduled_at)} at ${
        booking.slot_label?.trim() || formatBookingTime(booking.scheduled_at)
      }*.`;
    const clearPending = async (): Promise<void> => {
      await supabase.from("bookings").update({ pending_reschedule_at: null }).eq("id", booking.id);
    };

    // ── Legacy (no technician) helpers ──
    const legacyProposeMsg = (iso: string) =>
      `📅 I can move your SA'DA H2O installation to *${formatBookingDate(iso)} at ${formatBookingTime(iso)}*.\n\nReply *YES* to confirm, or send a different date & time.`;
    const legacyApplyConfirm = async (newAt: string): Promise<string> => {
      await supabase
        .from("bookings")
        .update({ scheduled_at: newAt, slot_label: null, pending_reschedule_at: null })
        .eq("id", booking.id);
      await supabase
        .from("leads")
        .update({ installation_date: newAt.slice(0, 10) })
        .eq("id", booking.lead_id);
      return buildBookingFreeText(rescheduleFields(booking, newAt, contactName, contactPhone));
    };
    const propose = async (iso: string): Promise<string> => {
      if (slotAware) return this.proposeSlotReschedule(supabase, userId, booking, iso);
      await supabase.from("bookings").update({ pending_reschedule_at: iso }).eq("id", booking.id);
      return legacyProposeMsg(iso);
    };

    let replyText: string;

    if (hasPending) {
      // Mid-confirmation: handle deterministically. NEVER fall through to the
      // AI's free text here — gpt-4o-mini will falsely claim it rescheduled.
      if (affirmative || intent === "confirm") {
        replyText = slotAware
          ? await this.confirmSlotReschedule(supabase, userId, booking, contactName, contactPhone)
          : await legacyApplyConfirm(booking.pending_reschedule_at as string);
      } else if (negative || intent === "cancel") {
        await clearPending();
        replyText = stays();
      } else if (newIso) {
        // Customer adjusted the proposed time (e.g. "make it 7:30pm") — re-propose.
        replyText = await propose(newIso);
      } else {
        // Couldn't parse a new time — re-ask without claiming anything happened.
        const p = booking.pending_reschedule_at as string;
        replyText = `You have a pending change to *${formatBookingDate(p)} at ${
          booking.slot_label?.trim() || formatBookingTime(p)
        }*.\n\nReply *YES* to confirm, or send the full new date & time.`;
      }
    } else if (intent === "propose" && newIso) {
      replyText = await propose(newIso);
    } else if (intent === "propose") {
      replyText = "Sure — what date and time works best for your installation?";
    } else if (intent === "cancel") {
      replyText = stays();
    } else {
      return null; // not a reschedule action — let the normal reply flow run
    }

    this.markInboundRead(wa, inboundMessageId);
    const sent = await wa.sendTextMessage(contactPhone, replyText);
    const outboundId = await this.persistOutboundMessage(supabase, {
      conversationId,
      userId,
      waMessageId: sent.messageId,
      body: replyText,
      aiGenerated: true,
    });
    return { outboundId };
  }

  /** Fire-and-forget read-receipt ack — call right alongside an actual reply send. */
  private markInboundRead(wa: WhatsAppService, inboundMessageId: string): void {
    void wa.markAsRead(inboundMessageId).catch((err: unknown) => {
      console.warn("Failed to mark message read (non-blocking)", {
        messageId: inboundMessageId,
        err: err instanceof Error ? err.message : err,
      });
    });
  }

  private async persistOutboundMessage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: {
      conversationId: string;
      userId: string;
      waMessageId: string;
      body: string;
      aiGenerated: boolean;
    }
  ): Promise<string> {
    const { data, error } = await supabase
      .from("whatsapp_messages")
      .insert({
        conversation_id: params.conversationId,
        user_id: params.userId,
        wa_message_id: params.waMessageId,
        direction: "outbound",
        message_type: "text",
        body: params.body,
        status: "sent",
        ai_generated: params.aiGenerated,
        sent_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (error || !data) {
      throw new Error(`Failed to persist outbound WhatsApp message: ${error?.message}`);
    }

    // Update conversation last_message_preview/last_message_at
    await supabase
      .from("whatsapp_conversations")
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: params.body.slice(0, 200),
      })
      .eq("id", params.conversationId);

    return data.id as string;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Current date/time in Riyadh, human-readable, for the AI to resolve relative dates. */
function formatRiyadhNow(): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Riyadh",
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date()) + " (Asia/Riyadh)"
  );
}

/** Builds the booking-confirmation message fields for a rescheduled booking. */
function rescheduleFields(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  booking: any,
  atIso: string,
  contactName: string | null,
  contactPhone: string,
  timeOverride?: string
): BookingMessageFields {
  return {
    clientName: contactName?.trim() || contactPhone,
    bookingRef: booking.booking_ref,
    product: booking.product_snapshot ?? "Water purifier",
    qty: booking.qty_snapshot ?? 1,
    totalFormatted:
      booking.total_amount != null ? Number(booking.total_amount).toLocaleString("en-US") : "—",
    currency: booking.currency ?? "SAR",
    dateFormatted: formatBookingDate(atIso),
    timeFormatted: timeOverride ?? formatBookingTime(atIso),
  };
}

/** Splits an ISO timestamp into Riyadh-local date (YYYY-MM-DD) and time (HH:MM). */
function riyadhDateAndTime(iso: string): { date: string; hhmm: string } {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const hhmm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return { date, hhmm };
}

/** "12:00:00" → "12:00 PM". */
function fmtSlotTime(t: string): string {
  const [h, m] = t.split(":");
  const hour = Number(h);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m} ${ampm}`;
}

/** "12:00 PM–1:00 PM, 2:00 PM–3:00 PM" for a list of slots. */
function formatSlotList(slots: Array<{ start_time: string; end_time: string }>): string {
  return slots.map((s) => `${fmtSlotTime(s.start_time)}–${fmtSlotTime(s.end_time)}`).join(", ");
}

/**
 * Downloads and re-hosts an inbound image/sticker/video/audio/document so it
 * can be displayed in the CRM — Meta's own media URLs expire within minutes.
 * Returns null (never throws) for text/location/interactive messages, or if
 * the download fails, so a media hiccup never blocks the rest of the pipeline.
 */
async function downloadInboundMedia(
  wa: WhatsAppService,
  userId: string,
  message: WhatsAppIncomingMessage
): Promise<string | null> {
  const mediaId =
    message.image?.id ??
    message.sticker?.id ??
    message.video?.id ??
    message.audio?.id ??
    message.document?.id ??
    null;
  if (!mediaId) return null;

  try {
    const { buffer, contentType } = await wa.downloadMedia(mediaId);
    const { url } = await uploadMediaBuffer(userId, "whatsapp-inbound", buffer, contentType);
    return url;
  } catch (err) {
    console.error("Failed to download/store inbound WhatsApp media", {
      userId,
      messageType: message.type,
      mediaId,
      err,
    });
    return null;
  }
}

function extractMessagePreview(message: WhatsAppIncomingMessage): string {
  switch (message.type) {
    case "text":
      return message.text?.body ?? "";
    case "image":
      return message.image?.caption ? `📷 ${message.image.caption}` : "📷 Image";
    case "video":
      return message.video?.caption ? `🎥 ${message.video.caption}` : "🎥 Video";
    case "audio":
      return message.audio?.voice === false ? "🎵 Audio file" : "🎙️ Voice note";
    case "document":
      return message.document?.filename ? `📎 ${message.document.filename}` : "📎 Document";
    case "sticker":
      return "🎨 Sticker";
    case "location":
      return message.location?.name ? `📍 ${message.location.name}` : "📍 Location";
    case "interactive":
      return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? "Interactive";
    default:
      return "(message)";
  }
}

function appendSignatureIfPresent(reply: string | null, signatureSuffix: string): string | null {
  if (!reply?.trim()) return null;
  const trimmedSig = signatureSuffix.trim();
  if (!trimmedSig) return reply.trim();
  // Avoid double-appending if the model already included it.
  if (reply.includes(trimmedSig)) return reply.trim();
  return `${reply.trim()}\n${trimmedSig}`;
}

function isWithinBusinessHours(config: WhatsAppAutomationConfigRow): boolean {
  if (!config.business_hours_start || !config.business_hours_end) return true;
  try {
    const tz = config.business_hours_timezone || "UTC";
    const now = new Date();
    const nowParts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const hour = Number(nowParts.find((p) => p.type === "hour")?.value);
    const minute = Number(nowParts.find((p) => p.type === "minute")?.value);
    const nowMinutes = hour * 60 + minute;

    const [startH, startM] = config.business_hours_start.split(":").map(Number);
    const [endH, endM] = config.business_hours_end.split(":").map(Number);
    const startMinutes = startH * 60 + (startM || 0);
    const endMinutes = endH * 60 + (endM || 0);

    // Handles ranges that don't cross midnight.
    if (startMinutes <= endMinutes) {
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // Crosses midnight: e.g. 22:00 → 06:00
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  } catch {
    return true; // If TZ parsing fails, fail-open rather than block replies.
  }
}
