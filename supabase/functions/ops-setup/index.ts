import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Deploy helper: push site files to Hostinger's file manager. Only callable with the cron secret (from the database).
// actions: upload {files:[{path, content}]}, patch {path, edits:[{old,new}], expect_sha}
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const sha = async (t: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function put(base: string, h: Record<string, string>, path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const url = `${base}/${path}?override=true`;
  const r1 = await fetch(url, { method: "POST", headers: { ...h, "Upload-Length": String(bytes.length), "Upload-Offset": "0" } });
  await r1.text();
  const r2 = await fetch(url, { method: "PATCH", headers: { ...h, "Content-Type": "application/offset+octet-stream", "Upload-Offset": "0" }, body: bytes });
  await r2.text();
  return { path, size: bytes.length, create: r1.status, patch: r2.status, offset: r2.headers.get("Upload-Offset"), sha: await sha(content) };
}

Deno.serve(async (req) => {
  const { data: s } = await db.schema("admin").from("settings").select("value").eq("key", "cron_secret").single();
  if (!s?.value || req.headers.get("x-ops-secret") !== s.value) return json({ ok: false, error: "unauthorized" }, 401);
  const b = await req.json().catch(() => ({}));
  const h = { "X-Auth": b.auth_key, "X-Auth-Rest": b.rest_auth_key, "Tus-Resumable": "1.0.0" };
  const base = String(b.upload_url || "");

  if (b.action === "upload") {
    const out = [];
    for (const f of b.files ?? []) out.push(await put(base, h, f.path, f.content));
    return json({ ok: true, results: out });
  }

  if (b.action === "patch") {
    const rawUrl = base.replace(/\/api\/tus$/, "/api/raw/") + b.path;
    const r = await fetch(rawUrl, { headers: { "X-Auth": b.auth_key, "X-Auth-Rest": b.rest_auth_key } });
    if (!r.ok) return json({ ok: false, error: "download", status: r.status, body: (await r.text()).slice(0, 300) });
    let text = await r.text();
    const before = await sha(text);
    for (const [i, e] of (b.edits ?? []).entries()) {
      const n = text.split(e.old).length - 1;
      if (n !== 1) return json({ ok: false, error: "edit_match", edit: i, matches: n, before });
      text = text.replace(e.old, () => e.new);
    }
    const after = await sha(text);
    if (b.expect_sha && after !== b.expect_sha) return json({ ok: false, error: "sha_mismatch", before, after, size: new TextEncoder().encode(text).length });
    if (b.dry_run) return json({ ok: true, dry_run: true, before, after });
    return json({ ok: true, result: await put(base, h, b.path, text), before });
  }
  return json({ ok: false, error: "unknown action" }, 400);
});
