import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Pulls finished Preet conversations from the ElevenLabs API and stores them
// in conversations + messages, linked to customers by WhatsApp number.
// Called every 5 minutes by pg_cron with header x-cron-secret (admin.settings.cron_secret).
// Secrets: ELEVENLABS_API_KEY. Optional: PREET_AGENT_ID.

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const adm = db.schema("admin");
const API = "https://api.elevenlabs.io/v1/convai";
const AGENT_ID = (Deno.env.get("PREET_AGENT_ID") ?? "").trim() || "agent_8401m61zzk44f7brtvfqjajw8fbk";
const FINISHED = new Set(["done", "failed"]);
const MAX_DETAILS_PER_RUN = 40;

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
  const { data } = await adm.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function el(path: string) {
  const key = (Deno.env.get("ELEVENLABS_API_KEY") ?? "").trim();
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const res = await fetch(API + path, { headers: { "xi-api-key": key } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ElevenLabs ${path} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");

// deno-lint-ignore no-explicit-any
function whatsappUserId(d: any): string | null {
  const dv = d?.conversation_initiation_client_data?.dynamic_variables ?? {};
  for (const c of [d?.user_id, dv.system__user_id]) {
    const v = digits(c);
    if (v.length >= 8) return v;
  }
  return null;
}

async function customerFor(waId: string | null): Promise<string | null> {
  if (!waId) return null;
  const { data: existing } = await db.from("customers").select("id").eq("whatsapp_user_id", waId).maybeSingle();
  if (existing) return existing.id;
  const { data: created, error } = await db.from("customers").insert({ whatsapp_user_id: waId }).select("id").single();
  if (error) {
    const { data: again } = await db.from("customers").select("id").eq("whatsapp_user_id", waId).maybeSingle();
    return again?.id ?? null;
  }
  return created.id;
}

// deno-lint-ignore no-explicit-any
async function store(d: any) {
  const waId = whatsappUserId(d);
  const customerId = await customerFor(waId);
  const meta = d.metadata ?? {};
  const startSecs = Number(meta.start_time_unix_secs ?? d.start_time_unix_secs ?? 0);
  const started = startSecs ? new Date(startSecs * 1000) : null;
  const durationSecs = Number(meta.call_duration_secs ?? 0);
  const ended = started ? new Date(started.getTime() + durationSecs * 1000) : null;
  // deno-lint-ignore no-explicit-any
  const transcript: any[] = Array.isArray(d.transcript) ? d.transcript : [];
  const analysis = d.analysis ?? {};
  const src = String(d.conversation_initiation_source ?? meta.conversation_initiation_source ?? "");
  const dv = d?.conversation_initiation_client_data?.dynamic_variables ?? {};
  const outbound = digits(dv.system__caller_id) !== "" && digits(dv.system__caller_id) !== waId;

  const { data: conv, error } = await db.from("conversations").upsert({
    elevenlabs_conversation_id: d.conversation_id,
    customer_id: customerId,
    whatsapp_user_id: waId,
    channel: src.includes("whatsapp") || !src ? "whatsapp" : src,
    direction: outbound ? "outbound" : "inbound",
    status: d.status ?? null,
    started_at: started?.toISOString() ?? null,
    ended_at: ended?.toISOString() ?? null,
    message_count: transcript.filter((t) => t?.message).length,
    summary: analysis.transcript_summary ?? null,
    title: analysis.call_summary_title ?? null,
    outcome: analysis.call_successful ?? null,
    metadata: { agent_id: d.agent_id ?? null, termination_reason: meta.termination_reason ?? null },
  }, { onConflict: "elevenlabs_conversation_id" }).select("id").single();
  if (error) throw new Error(error.message);

  await db.from("messages").delete().eq("conversation_id", conv.id);
  // deno-lint-ignore no-explicit-any
  const rows = transcript.map((t: any, i: number) => {
    const tool = Array.isArray(t?.tool_calls) && t.tool_calls.length ? t.tool_calls[0] : null;
    return {
      conversation_id: conv.id,
      customer_id: customerId,
      seq: i + 1,
      role: t?.role === "user" ? "customer" : t?.role === "agent" ? "agent" : "system",
      body: t?.message ?? null,
      tool_name: tool?.tool_name ?? null,
      tool_payload: tool ? { call: tool, result: t?.tool_results?.[0] ?? null } : null,
      sent_at: started ? new Date(started.getTime() + Number(t?.time_in_call_secs ?? 0) * 1000).toISOString() : null,
    };
  }).filter((r) => r.body || r.tool_name);
  if (rows.length) {
    const { error: mErr } = await db.from("messages").insert(rows);
    if (mErr) throw new Error(mErr.message);
  }
  return rows.length;
}

async function sync() {
  const cursor = Number(await setting("chat_sync_cursor") ?? 0);

  // 1. List conversations that started at or after the cursor (all pages)
  // deno-lint-ignore no-explicit-any
  const listed: any[] = [];
  let page: string | null = null;
  do {
    const qs = new URLSearchParams({ agent_id: AGENT_ID, page_size: "100" });
    if (cursor > 0) qs.set("call_start_after_unix", String(cursor));
    if (page) qs.set("cursor", page);
    const data = await el(`/conversations?${qs}`);
    listed.push(...(data.conversations ?? []));
    page = data.has_more ? (data.next_cursor ?? data.cursor ?? null) : null;
  } while (page);

  // 2. Skip finished ones we already stored
  const ids = listed.map((c) => c.conversation_id);
  const stored = new Set<string>();
  if (ids.length) {
    const { data } = await db.from("conversations").select("elevenlabs_conversation_id,status").in("elevenlabs_conversation_id", ids);
    for (const r of data ?? []) if (FINISHED.has(String(r.status))) stored.add(r.elevenlabs_conversation_id);
  }

  const finished = listed.filter((c) => FINISHED.has(String(c.status)) && !stored.has(c.conversation_id))
    .sort((a, b) => a.start_time_unix_secs - b.start_time_unix_secs)
    .slice(0, MAX_DETAILS_PER_RUN);
  const pending = listed.filter((c) => !FINISHED.has(String(c.status)));

  // 3. Fetch and store each finished conversation
  let saved = 0, messages = 0;
  const errors: string[] = [];
  for (const c of finished) {
    try {
      const detail = await el(`/conversations/${encodeURIComponent(c.conversation_id)}`);
      messages += await store(detail);
      saved++;
    } catch (e) {
      errors.push(`${c.conversation_id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  // 4. Move the cursor: never past a chat that's still open or that failed to save
  const leftBehind = listed.filter((c) =>
    !FINISHED.has(String(c.status)) || (FINISHED.has(String(c.status)) && !stored.has(c.conversation_id) && !finished.slice(0, saved).some((f) => f.conversation_id === c.conversation_id))
  );
  let next = cursor;
  if (leftBehind.length) next = Math.max(cursor, Math.min(...leftBehind.map((c) => Number(c.start_time_unix_secs))));
  else if (listed.length) next = Math.max(cursor, Math.max(...listed.map((c) => Number(c.start_time_unix_secs))) + 1);
  if (errors.length === 0 || next !== cursor) {
    await adm.from("settings").upsert({ key: "chat_sync_cursor", value: next, updated_at: new Date().toISOString() });
  }

  return { listed: listed.length, saved, messages, still_open: pending.length, cursor: next, errors };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = String((await setting("cron_secret")) ?? "");
  if (!secret || !safeEqual(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);
  try {
    return json({ ok: true, ...(await sync()) });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
