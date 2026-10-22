-- Outbound webhook integration: lets an external system (e.g. another CRM/
-- booking platform) receive a real-time HTTP POST whenever a new lead is
-- created or a new message arrives on any channel, without the application
-- code having to remember to call out at every lead/message insert site.
-- Implemented as database triggers (via pg_net, async/non-blocking) so it
-- fires no matter which code path performs the insert, now or in future.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- One row per tenant. Mirrors the single-shared-tenant pattern used by
-- whatsapp_automation_configs etc.
CREATE TABLE public.outbound_webhook_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  webhook_url TEXT,
  webhook_secret TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.outbound_webhook_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Any authenticated user can view outbound webhook config"
  ON public.outbound_webhook_configs FOR SELECT USING (auth.uid() IS NOT NULL);

CREATE POLICY "Any authenticated user can insert outbound webhook config"
  ON public.outbound_webhook_configs FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "Any authenticated user can update outbound webhook config"
  ON public.outbound_webhook_configs FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE TRIGGER outbound_webhook_configs_updated_at
  BEFORE UPDATE ON public.outbound_webhook_configs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Generic trigger function, parameterized by event name (TG_ARGV[0]).
-- Looks up the tenant's webhook config, builds a payload, and fires an
-- async POST via pg_net (does not block the triggering transaction).
-- Signs the payload with HMAC-SHA256 (hex) in X-Webhook-Signature so the
-- receiver can verify authenticity, the same way GitHub/Stripe webhooks do.
CREATE OR REPLACE FUNCTION public.fire_outbound_webhook()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg RECORD;
  event_name TEXT;
  payload JSONB;
  signature TEXT;
BEGIN
  SELECT webhook_url, webhook_secret, enabled
  INTO cfg
  FROM public.outbound_webhook_configs
  WHERE user_id = NEW.user_id
  LIMIT 1;

  IF cfg IS NULL OR cfg.enabled IS NOT TRUE OR cfg.webhook_url IS NULL OR cfg.webhook_url = '' THEN
    RETURN NEW;
  END IF;

  event_name := TG_ARGV[0];
  payload := jsonb_build_object(
    'event', event_name,
    'table', TG_TABLE_NAME,
    'timestamp', to_jsonb(now()),
    'data', to_jsonb(NEW)
  );

  signature := CASE
    WHEN cfg.webhook_secret IS NOT NULL AND cfg.webhook_secret != '' THEN
      encode(extensions.hmac(payload::text, cfg.webhook_secret, 'sha256'), 'hex')
    ELSE NULL
  END;

  PERFORM net.http_post(
    url := cfg.webhook_url,
    body := payload,
    headers := CASE
      WHEN signature IS NOT NULL THEN
        jsonb_build_object('Content-Type', 'application/json', 'X-Webhook-Signature', signature)
      ELSE
        jsonb_build_object('Content-Type', 'application/json')
    END,
    timeout_milliseconds := 8000
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER leads_outbound_webhook
  AFTER INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.fire_outbound_webhook('lead.created');

CREATE TRIGGER whatsapp_messages_outbound_webhook
  AFTER INSERT ON public.whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION public.fire_outbound_webhook('message.created');

CREATE TRIGGER instagram_dm_messages_outbound_webhook
  AFTER INSERT ON public.instagram_dm_messages
  FOR EACH ROW EXECUTE FUNCTION public.fire_outbound_webhook('message.created');

CREATE TRIGGER messenger_messages_outbound_webhook
  AFTER INSERT ON public.messenger_messages
  FOR EACH ROW EXECUTE FUNCTION public.fire_outbound_webhook('message.created');
