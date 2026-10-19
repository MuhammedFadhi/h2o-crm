import Link from "next/link";
import { ArrowLeft, Bot, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AutoRefresh } from "@/components/whatsapp/auto-refresh";
import { AiPauseToggle } from "@/components/whatsapp/ai-pause-toggle";
import { ScrollToBottomOnMount } from "@/components/whatsapp/scroll-to-bottom-on-mount";
import { ManualReplyInput } from "./manual-reply-input";

export interface InstagramConversationDetail {
  id: string;
  contact_ig_id: string;
  contact_username: string | null;
  contact_name: string | null;
  last_message_at: string | null;
  created_at: string;
  ai_paused: boolean;
}

export interface InstagramMessageRow {
  id: string;
  ig_message_id: string | null;
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
  conversation: InstagramConversationDetail;
  messages: InstagramMessageRow[];
}

/** Instagram DM thread view (customer left, Page/AI right) — reply box, AI pause toggle, and auto-refresh included. */
export function InstagramConversationThread({ conversation, messages }: ConversationThreadProps) {
  const displayName =
    conversation.contact_name?.trim() ||
    (conversation.contact_username ? `@${conversation.contact_username}` : `Instagram ${conversation.contact_ig_id.slice(-6)}`);

  return (
    <div className="max-w-4xl">
      <Link
        href="/instagram"
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-foreground mb-4 transition-colors"
      >
        <ArrowLeft size={14} strokeWidth={1.8} />
        Back to conversations
      </Link>

      <div className="mb-6 pb-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-surface flex items-center justify-center shrink-0">
            <User size={22} strokeWidth={1.8} className="text-text-muted" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold tracking-[-0.5px] font-[family-name:var(--font-heading)] text-foreground truncate">
              {displayName}
            </h1>
            <p className="text-xs text-text-muted mt-0.5">
              {messages.length} message{messages.length === 1 ? "" : "s"}
            </p>
          </div>
          <AiPauseToggle
            conversationId={conversation.id}
            initiallyPaused={conversation.ai_paused}
            channel="instagram"
          />
        </div>
      </div>

      {/* Polls server-rendered data every 5s so new messages appear */}
      <AutoRefresh intervalMs={5000} />
      {/* Invisible — lands the page scrolled to the latest messages + reply box, not the top */}
      <ScrollToBottomOnMount />

      {messages.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-elevated p-10 flex flex-col items-center text-center">
          <p className="text-sm text-text-muted">No messages yet in this conversation.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>
      )}

      <ManualReplyInput conversationId={conversation.id} />
    </div>
  );
}

function MessageBubble({ message }: { message: InstagramMessageRow }) {
  const isOutbound = message.direction === "outbound";
  const timestamp = message.sent_at || message.created_at;
  const hasMedia = Boolean(message.media_url) && ["image", "video", "audio"].includes(message.message_type);

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] ${isOutbound ? "items-end" : "items-start"} flex flex-col gap-1`}>
        <div
          className={`rounded-2xl overflow-hidden ${hasMedia ? "p-1.5" : "px-4 py-2.5"} ${
            isOutbound
              ? "bg-primary text-black rounded-br-sm"
              : "bg-surface-elevated border border-border text-foreground rounded-bl-sm"
          }`}
        >
          <MediaContent message={message} />
          {message.body && !hasMedia && (
            <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>
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
        </div>
      </div>
    </div>
  );
}

/** Renders the actual media for image/video/audio messages; falls back to a text placeholder otherwise. */
function MediaContent({ message }: { message: InstagramMessageRow }) {
  const { message_type, media_url, body } = message;

  if (media_url) {
    switch (message_type) {
      case "image":
        return (
          <a href={media_url} target="_blank" rel="noopener noreferrer" title="Open full size / download">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={media_url}
              alt={body || "Image"}
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
        return <audio controls src={media_url} className="w-64 max-w-full" />;
    }
  }

  const label =
    message_type === "image"
      ? "📷 Image"
      : message_type === "video"
      ? "🎥 Video"
      : message_type === "audio"
      ? "🎙️ Audio"
      : message_type === "share"
      ? "🔗 Shared post"
      : message_type === "story_reply"
      ? "↩️ Story reply"
      : null;

  if (label) return <p className="text-sm italic opacity-70">{body || label}</p>;
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
