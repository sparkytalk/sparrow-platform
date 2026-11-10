import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// Contractor and crew sign-up and password links. Public endpoint; the long random token is the proof.
// POST { action: "check", token }            -> who the link is for
// POST { action: "claim", token, password }  -> set password, link account, returns email to sign in with
// POST { action: "claim_oauth", token } + Authorization: Bearer <session from Google sign-in>
//                                             -> link the signed-in account to the invite (no password)
// A Sparrow admin login can never be used here: admins stay separate from Sparrow Pros.

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const adm = db.schema("admin");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const ADMIN_MSG = "That email belongs to a Sparrow admin account. Use a different email for Sparrow Pros.";

async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isAdmin(userId: string | null) {
  if (!userId) return false;
  const { data } = await adm.from("admins").select("user_id").eq("user_id", userId).maybeSingle();
  return !!data;
}

// deno-lint-ignore no-explicit-any
type Found = { kind: "contractor"; invite: any; c: any } | { kind: "crew"; m: any };

async function findInvite(token: string): Promise<Found | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await sha256(token);
  const { data } = await db.from("contractor_invites")
    .select("id, kind, expires_at, used_at, contractor:contractors(id, business_name, contact_name, email, user_id, status)")
    .eq("token_hash", hash).maybeSingle();
  if (data && !data.used_at && new Date(data.expires_at) >= new Date()) {
    // deno-lint-ignore no-explicit-any
    const c: any = data.contractor;
    if (c && c.status !== "left") return { kind: "contractor", invite: data, c };
  }
  const { data: m } = await db.rpc("crew_invite_lookup", { p_hash: hash });
  if (m && m.id) return { kind: "crew", m };
  return null;
}

async function upsertUser(userId: string | null, email: string, password: string, role: string) {
  if (!userId) {
    const { data: existing } = await db.rpc("auth_user_id_by_email", { p_email: email });
    userId = existing ?? null;
  }
  if (await isAdmin(userId)) return { error: ADMIN_MSG };
  if (userId) {
    const { error } = await db.auth.admin.updateUserById(userId, { password, email_confirm: true });
    if (error) return { error: error.message };
    return { userId };
  }
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role } });
  if (error || !data.user) return { error: error?.message ?? "Could not create the account." };
  return { userId: data.user.id };
}

// Is this login already used by some other business or crew?
async function linkedElsewhere(userId: string, except: { contractor?: string; member?: string }) {
  const { data: c } = await db.from("contractors").select("id").eq("user_id", userId).neq("status", "left");
  if ((c ?? []).some((x) => x.id !== except.contractor)) return true;
  const { data: m } = await db.from("team_members").select("id").eq("user_id", userId);
  return (m ?? []).some((x) => x.id !== except.member);
}

async function linkCrew(m: { id: string }, userId: string, how: string) {
  const { error } = await db.from("team_members").update({ user_id: userId, joined_at: new Date().toISOString(), invite_token_hash: null }).eq("id", m.id);
  if (error) return error.message.includes("team_members_user") ? "This login is already on another team." : error.message;
  await adm.from("audit_log").insert({ actor: "crew", actor_id: userId, action: "team.joined", table_name: "team_members", row_id: m.id, diff: { how } });
  return null;
}

// deno-lint-ignore no-explicit-any
async function linkContractor(invite: any, c: any, userId: string, how: string) {
  const patch: Record<string, unknown> = { user_id: userId };
  if (c.status === "invited") patch.status = "setting_up";
  const { error } = await db.from("contractors").update(patch).eq("id", c.id);
  if (error) return error.message;
  await db.from("contractor_invites").update({ used_at: new Date().toISOString() }).eq("id", invite.id);
  await adm.from("audit_log").insert({ actor: "contractor", actor_id: userId, action: invite.kind === "reset" ? "contractor.password_reset" : "contractor.account_created", table_name: "contractors", row_id: c.id, diff: { how } });
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body: Record<string, string> = {};
  try { body = await req.json(); } catch { /* */ }

  const found = await findInvite(String(body.token ?? ""));
  if (!found) return json({ ok: false, error: "invalid_link", message: "This link has expired or was already used. Ask for a new one." });

  if (body.action === "check") {
    if (found.kind === "crew") return json({ ok: true, kind: "crew", business_name: found.m.business_name, contact_name: found.m.full_name, email: found.m.email });
    return json({ ok: true, kind: found.invite.kind, business_name: found.c.business_name, contact_name: found.c.contact_name, email: found.c.email });
  }

  if (body.action === "claim_oauth") {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(jwt);
    if (!u?.user) return json({ ok: false, error: "auth", message: "Sign-in didn't finish. Open the invite link and try again." }, 401);
    const userId = u.user.id;
    if (await isAdmin(userId)) return json({ ok: false, error: "admin", message: ADMIN_MSG });
    if (found.kind === "crew") {
      if (found.m.user_id && found.m.user_id !== userId) return json({ ok: false, error: "taken", message: "This invite was already used." });
      if (await linkedElsewhere(userId, { member: found.m.id })) return json({ ok: false, error: "taken", message: "That Google account is already used for another Sparrow Pros account. Use a different one or set a password instead." });
      const e = await linkCrew(found.m, userId, "google");
      return json(e ? { ok: false, error: "link", message: e } : { ok: true });
    }
    const { invite, c } = found;
    if (c.user_id && c.user_id !== userId) return json({ ok: false, error: "taken", message: invite.kind === "reset" ? "Sign in with the same account you used before, or set a new password instead." : "This business already has an account." });
    if (await linkedElsewhere(userId, { contractor: c.id })) return json({ ok: false, error: "taken", message: "That Google account is already used for another Sparrow Pros account. Use a different one or set a password instead." });
    const e = await linkContractor(invite, c, userId, "google");
    return json(e ? { ok: false, error: "link", message: e } : { ok: true });
  }

  if (body.action === "claim") {
    const password = String(body.password ?? "");
    if (password.length < 10) return json({ ok: false, error: "weak_password", message: "Use at least 10 characters." });

    if (found.kind === "crew") {
      const m = found.m;
      const r = await upsertUser(m.user_id, m.email, password, "crew");
      if ("error" in r) return json({ ok: false, error: "auth", message: r.error });
      const e = await linkCrew(m, r.userId!, "password");
      if (e) return json({ ok: false, error: "link", message: e });
      return json({ ok: true, email: m.email });
    }

    const { invite, c } = found;
    const r = await upsertUser(c.user_id, c.email, password, "contractor");
    if ("error" in r) return json({ ok: false, error: "auth", message: r.error });
    const e = await linkContractor(invite, c, r.userId!, "password");
    if (e) return json({ ok: false, error: "link", message: e });
    return json({ ok: true, email: c.email });
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
