import Link from "next/link";
import { ArrowLeft, Bot, Phone, AlertCircle, Check, CheckCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ManualReplyInput } from "./manual-reply-input";
import { AiPauseToggle } from "./ai-pause-toggle";
import { AutoRefresh } from "./auto-refresh";
import { ConvertToLeadButton } from "./convert-to-lead-button";
import { VoiceNotePlayer } from "./voice-note-player";
import { ScrollToBottomOnMount } from "./scroll-to-bottom-on-mount";
import { ContactAvatar } from "./contact-avatar";

export interface WhatsAppConversationDetail {
  id: string;
  contact_phone: string;
  contact_name: string | null;
  last_message_at: string | null;
  created_at: string;
  ai_paused: boolean;
}

export interface WhatsAppMessageRow {
  id: string;
  wa_message_id: string | null;
  direction: "inbound" | "outbound";
  message_type: string;
  body: string | null;
  media_url: string | null;
  status: string;
  ai_generated: boolean;
  sent_at: string | null;
  created_at: string;
}

interface ConversationThreadProps {
  conversation: WhatsAppConversationDetail;
  messages: WhatsAppMessageRow[];
}

/**
 * Server-rendered conversation thread view. Displays all messages between the
 * business and a single customer in a familiar chat-bubble layout (customer
 * messages on the left, business/AI replies on the right).
 */
export function ConversationThread({ conversation, messages }: ConversationThreadProps) {
  return (
    <div className="max-w-4xl">
      {/* Header */}
      <Link
        href="/whatsapp"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-foreground mb-4 transition-colors"
      >
        <ArrowLeft size={14} strokeWidth={1.8} />
        Back to conversations
      </Link>

      <div className="mb-6 pb-4 border-b border-border">
        <div className="flex items-center gap-3">
          <ContactAvatar name={conversation.contact_name} size={48} />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold tracking-[-0.5px] font-[family-name:var(--font-heading)] text-foreground truncate">
              {conversation.contact_name?.trim() || conversation.contact_phone}
            </h1>
            <p className="text-xs text-text-muted flex items-center gap-1 mt-0.5">
              <Phone size={11} strokeWidth={1.8} />
              <span className="font-mono">{conversation.contact_phone}</span>
              <span className="mx-1.5 text-border">•</span>
              <span>
                {messages.length} message{messages.length === 1 ? "" : "s"}
              </span>
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <AiPauseToggle
              conversationId={conversation.id}
              initiallyPaused={conversation.ai_paused}
            />
            <ConvertToLeadButton conversationId={conversation.id} />
          </div>
        </div>
      </div>

      {/* Invisible — polls server-rendered data every 5s so new messages appear */}
      <AutoRefresh intervalMs={5000} />
      {/* Invisible — lands the page scrolled to the latest messages + reply box, not the top */}
      <ScrollToBottomOnMount />

      {/* Messages */}
      {messages.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-elevated p-10 flex flex-col items-center text-center">
          <p className="text-sm text-text-muted">No messages yet in this conversation.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} contactName={conversation.contact_name} />
          ))}
        </div>
      )}

      {/* Manual reply input */}
      <ManualReplyInput contactPhone={conversation.contact_phone} />
    </div>
  );
}

function MessageBubble({ message, contactName }: { message: WhatsAppMessageRow; contactName: string | null }) {
  const isOutbound = message.direction === "outbound";
  const timestamp = message.sent_at || message.created_at;

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] ${isOutbound ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div
          className={`rounded-2xl overflow-hidden ${
            message.message_type === "audio" && message.media_url
              ? "px-2.5 py-2"
              : message.media_url
                ? "p-1.5"
                : "px-4 py-2.5"
          } ${
            isOutbound
              ? "bg-primary text-black rounded-br-sm"
              : "bg-surface-elevated border border-border text-foreground rounded-bl-sm"
          }`}
        >
          <MediaContent message={message} contactName={contactName} />
          {message.body &&
            !["sticker", "audio", "audio_file", "document", "location"].includes(message.message_type) && (
              <p className="text-sm whitespace-pre-wrap break-words px-0.5 mt-1">{message.body}</p>
            )}
        </div>
        <div
          className={`flex items-center gap-2 text-[10px] text-text-muted px-1 ${
            isOutbound ? "flex-row-reverse" : ""
          }`}
        >
          <span>{formatTime(timestamp)}</span>
          {message.ai_generated && (
            <Badge variant="processing" className="!px-1.5 !py-0 !text-[9px]">
              <Bot size={9} strokeWidth={2} />
              AI
            </Badge>
          )}
          {isOutbound && <MessageStatusTicks status={message.status} />}
        </div>
      </div>
    </div>
  );
}

/** WhatsApp-style tick marks for an outbound message's delivery status. */
function MessageStatusTicks({ status }: { status: string }) {
  if (status === "failed") {
    return <AlertCircle size={12} strokeWidth={2} className="text-error" />;
  }
  if (status === "read") {
    return <CheckCheck size={13} strokeWidth={2} className="text-primary" />;
  }
  if (status === "delivered") {
    return <CheckCheck size={13} strokeWidth={2} className="text-text-muted" />;
  }
  // "sent" (and anything else outbound-but-not-yet-confirmed) — single tick.
  return <Check size={13} strokeWidth={2} className="text-text-muted" />;
}

/**
 * Renders the actual media for image/sticker/video/audio/document messages.
 * Falls back to a text placeholder if the media couldn't be downloaded and
 * re-hosted (media_url is null) — e.g. a transient fetch failure.
 */
function MediaContent({
  message,
  contactName,
}: {
  message: WhatsAppMessageRow;
  contactName: string | null;
}) {
  const { message_type, media_url, body } = message;

  if (media_url) {
    switch (message_type) {
      case "image":
      case "sticker":
        return (
          <a href={media_url} target="_blank" rel="noopener noreferrer" title="Open full size / download">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={media_url}
              alt={body || message_type}
              className="max-w-full max-h-72 rounded-xl object-contain cursor-zoom-in"
            />
          </a>
        );
      case "video":
        return (
          <video controls className="max-w-full max-h-72 rounded-xl">
            <source src={media_url} />
          </video>
        );
      case "audio":
        return (
          <VoiceNotePlayer
            src={media_url}
            seed={message.id}
            variant={message.direction === "outbound" ? "outbound" : "inbound"}
            contactName={contactName}
          />
        );
      case "audio_file":
        return <audio controls src={media_url} className="w-64 max-w-full" />;
      case "document":
        return (
          <a
            href={media_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-2 py-1.5 text-sm underline underline-offset-2"
          >
            📎 {body?.replace(/^📎 /, "") || "Document"}
          </a>
        );
    }
  }

  // No media_url yet (download failed, or a non-media type) — text placeholder.
  if (["image", "video", "audio", "audio_file", "document", "sticker"].includes(message_type)) {
    const label =
      message_type === "image"
        ? "📷 Image"
        : message_type === "video"
        ? "🎥 Video"
        : message_type === "audio"
        ? "🎙️ Voice note"
        : message_type === "audio_file"
        ? "🎵 Audio file"
        : message_type === "document"
        ? "📎 Document"
        : "🎨 Sticker";
    return <p className="text-sm italic opacity-70">{body || label}</p>;
  }

  if (message_type === "location") {
    return <p className="text-sm italic opacity-70">{body || "📍 Location"}</p>;
  }

  return null;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    timeZone: "Asia/Riyadh",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
