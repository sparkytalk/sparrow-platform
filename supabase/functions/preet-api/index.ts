import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Preet's tools: POST /functions/v1/preet-api/<tool>
// Header x-preet-key must match admin.settings.preet_api_key.
// Body: { whatsapp_user_id, conversation_id?, ...tool args }

const TOOLS = new Set([
  "identify_customer", "save_onboarding", "get_price", "create_booking",
  "get_my_jobs", "cancel_job", "report_problem", "rate_job", "request_human",
  "note_unmet_request", "get_free_days",
]);

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const adm = db.schema("admin");

let apiKey: string | null = null;
let keyLoadedAt = 0;
async function getKey(): Promise<string | null> {
  if (apiKey && Date.now() - keyLoadedAt < 5 * 60_000) return apiKey;
  const { data } = await adm.from("settings").select("value").eq("key", "preet_api_key").single();
  apiKey = typeof data?.value === "string" ? data.value : null;
  keyLoadedAt = Date.now();
  return apiKey;
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const started = Date.now();
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  const key = await getKey();
  const sent = req.headers.get("x-preet-key") ?? "";
  if (!key || !safeEqual(sent, key)) return json({ ok: false, error: "unauthorized" }, 401);

  const tool = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!TOOLS.has(tool)) return json({ ok: false, error: "unknown_tool" }, 404);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const wa = String(body.whatsapp_user_id ?? "");
  const conversationId = body.conversation_id ? String(body.conversation_id) : null;
  const args = { ...body };
  delete args.whatsapp_user_id;

  let result: unknown;
  let status = 200;
  const { data, error } = await db.rpc("preet_call", { p_tool: tool, p_wa: wa, p_args: args });
  if (error) {
    console.error(tool, error.message);
    status = 500;
    result = { ok: false, error: "server_error", message: "Something went wrong saving this. Apologise and say the Sparrow team will follow up." };
  } else {
    result = data;
  }

  // audit log (best effort)
  const customerId = (await db.from("customers").select("id").eq("whatsapp_user_id", wa.replace(/\D/g, "")).maybeSingle()).data?.id ?? null;
  adm.from("tool_calls").insert({
    tool, conversation_id: conversationId, customer_id: customerId,
    request: args, response: result as Record<string, unknown>, status_code: status, duration_ms: Date.now() - started,
  }).then(({ error: e }) => e && console.error("log", e.message));

  // Always 200 so Preet reads the message and replies sensibly
  return json(result, 200);
});
