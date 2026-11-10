import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Sends queued WhatsApp template messages from the outbox through the ElevenLabs API.
// Only runs when admin.settings.whatsapp_templates_enabled = true.
// Outbox row: channel 'whatsapp_template', recipient = WhatsApp user id (digits),
//   template_name, payload = { "params": ["..."], "language": "en" (optional) }.
// Secrets: ELEVENLABS_API_KEY, WHATSAPP_PHONE_NUMBER_ID. Optional: PREET_AGENT_ID.

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const AGENT_ID = env("PREET_AGENT_ID") || "agent_8401m61zzk44f7brtvfqjajw8fbk";
const MAX_ATTEMPTS = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function setting(key: string) {
  const { data } = await db.schema("admin").from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function sendTemplate(to: string, template: string, params: string[], language?: string) {
  const key = env("ELEVENLABS_API_KEY");
  const phoneId = env("WHATSAPP_PHONE_NUMBER_ID");
  if (!key || !phoneId) throw new Error("ELEVENLABS_API_KEY or WHATSAPP_PHONE_NUMBER_ID is not set");
  const langs = [...new Set([language || "en", "en", "en_US", "en_GB"])];
  let last = "";
  for (const lang of langs) {
    const res = await fetch("https://api.elevenlabs.io/v1/convai/whatsapp/outbound-message", {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        whatsapp_phone_number_id: phoneId,
        whatsapp_user_id: to.replace(/\D/g, ""),
        template_name: template,
        template_language_code: lang,
        template_params: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text: String(text) })) }] : [],
        agent_id: AGENT_ID,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data.conversation_id ?? null;
    last = `HTTP ${res.status} (${lang}): ${JSON.stringify(data).slice(0, 300)}`;
    if ((data?.detail?.code ?? "") !== "template_not_found") break;
  }
  throw new Error(last);
}

async function run() {
  const enabled = (await setting("whatsapp_templates_enabled")) === true;
  if (!enabled) return { enabled: false, sent: 0, failed: 0 };

  const { data: rows } = await db.from("outbox")
    .select("id,recipient,template_name,payload,attempts")
    .eq("channel", "whatsapp_template").eq("status", "queued")
    .lte("send_after", new Date().toISOString())
    .order("created_at").limit(25);

  let sent = 0, failed = 0;
  for (const r of rows ?? []) {
    try {
      const convId = await sendTemplate(r.recipient, r.template_name, r.payload?.params ?? [], r.payload?.language);
      await db.from("outbox").update({
        status: "sent", sent_at: new Date().toISOString(), attempts: r.attempts + 1, last_error: null,
        payload: { ...(r.payload ?? {}), elevenlabs_conversation_id: convId },
      }).eq("id", r.id);
      sent++;
    } catch (e) {
      const attempts = r.attempts + 1;
      await db.from("outbox").update({
        attempts,
        last_error: String((e as Error)?.message ?? e),
        status: attempts >= MAX_ATTEMPTS ? "failed" : "queued",
        send_after: new Date(Date.now() + attempts * attempts * 60_000).toISOString(), // 1, 4, 9, 16 min back-off
      }).eq("id", r.id);
      failed++;
    }
  }
  return { enabled: true, sent, failed };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = String((await setting("cron_secret")) ?? "");
  if (!secret || !safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);
  try {
    return json({ ok: true, ...(await run()) });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
