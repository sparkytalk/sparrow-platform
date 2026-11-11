// Public sign-up for Sparrow Pros: creates the login and the business (14-day free trial) in one step.
// POST { email, password, business_name, contact_name, phone, trade }
// The page then signs in with the same email and password.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const friendly = (m: string) => m.replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/\.?$/, '.')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ ok: false }, 405)
  const b = await req.json().catch(() => ({})) as Record<string, string>
  const email = String(b.email ?? '').trim().toLowerCase()
  const password = String(b.password ?? '')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, message: 'Enter a valid email.' })
  if (password.length < 10) return json({ ok: false, message: 'Use a password of at least 10 characters.' })
  for (const k of ['business_name', 'contact_name', 'phone']) if (!String(b[k] ?? '').trim()) return json({ ok: false, message: 'Fill in every field.' })
  const digits = String(b.phone).replace(/\D/g, '')
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) return json({ ok: false, message: 'Enter a 10-digit phone number.' })

  try {
    // simple abuse guard: at most 30 new businesses per hour
    const { count } = await db.schema('admin').from('audit_log').select('id', { count: 'exact', head: true })
      .eq('action', 'pros.signup').gte('created_at', new Date(Date.now() - 3600e3).toISOString())
    if ((count ?? 0) >= 30) return json({ ok: false, message: 'Too many sign-ups right now. Try again in a few minutes.' })

    const { data: existing } = await db.rpc('auth_user_id_by_email', { p_email: email })
    if (existing) return json({ ok: false, exists: true, message: 'This email already has an account. Sign in instead.' })

    const { data: u, error } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role: 'owner' } })
    if (error || !u.user) return json({ ok: false, message: error?.message ?? 'Could not create the account.' })

    const { error: e2 } = await db.rpc('pros_create_business', {
      p_user: u.user.id,
      p: { business_name: b.business_name, contact_name: b.contact_name, phone: b.phone, trade: b.trade ?? '' },
    })
    if (e2) {
      await db.auth.admin.deleteUser(u.user.id)
      return json({ ok: false, message: friendly(e2.message) })
    }
    return json({ ok: true })
  } catch (e) {
    console.error(e)
    return json({ ok: false, message: 'Something went wrong. Try again.' }, 500)
  }
})
