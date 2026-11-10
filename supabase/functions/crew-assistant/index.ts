// OLD voice assistant (ElevenLabs). The crew app now uses ai-assistant (Claude); kept only as a fallback.
// Creates a session pass in the database and returns a one-time signed ElevenLabs link.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'

const URL_ = Deno.env.get('SUPABASE_URL')!
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const AGENT_ID = 'agent_3701m6e5k2vafw6a0jce9sfwhs0n'
const EL_KEY = (Deno.env.get('ELEVENLABS_API_KEY') ?? '').trim()
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const clip = (s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '…' : s

type Conv = { id: string; el_conversation_id: string; summary: string | null; started_at: string; when: string; messages: { role: string; body: string }[] }

async function signedUrl(): Promise<string | null> {
  if (!EL_KEY) return null
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${AGENT_ID}`, { headers: { 'xi-api-key': EL_KEY } })
  if (!r.ok) { console.error('signed url', r.status, await r.text()); return null }
  return (await r.json()).signed_url ?? null
}
async function summaryOf(id: string): Promise<string | null> {
  if (!EL_KEY || !/^[A-Za-z0-9_-]{6,80}$/.test(id)) return null
  const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${id}`, { headers: { 'xi-api-key': EL_KEY } })
  if (!r.ok) return null
  const j = await r.json()
  if (j?.agent_id && j.agent_id !== AGENT_ID) return null
  return j?.analysis?.transcript_summary ?? null
}

async function fillSummaries(convs: Conv[]) {
  const todo = convs.filter(c => !c.summary && Date.now() - Date.parse(c.started_at) > 60e3).slice(-3)
  await Promise.all(todo.map(async c => {
    try {
      const s = await summaryOf(c.el_conversation_id)
      if (typeof s === 'string' && s.trim()) {
        c.summary = s.trim()
        await admin.rpc('assistant_set_summary', { p_conv: c.id, p_summary: c.summary })
      }
    } catch (e) { console.error('summary', String(e)) }
  }))
}

function memory(convs: Conv[]) {
  const parts: string[] = []
  for (const c of convs) {
    if (c.summary) { parts.push(`- ${c.when}: ${clip(c.summary, 300)}`); continue }
    if (!c.messages.length) continue
    const asked = c.messages.filter(m => m.role === 'user').map(m => m.body.replace(/\s+/g, ' ')).join(' | ')
    const last = c.messages.filter(m => m.role === 'agent').at(-1)?.body.replace(/\s+/g, ' ') ?? ''
    parts.push(`- ${c.when}: crew said: ${clip(asked, 200)}${last ? `; assistant last replied: ${clip(last, 120)}` : ''}`)
  }
  const m = parts.join('\n')
  return m ? clip(m, 1800) : 'No earlier conversations.'
}

function same(a: string, b: string) {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method' }, 405)
  try {
    const check = req.headers.get('x-ops-check')
    if (check) {
      const { data } = await admin.schema('admin').from('ops_kv').select('v').eq('k', 'el_relay').single()
      if (!data?.v?.secret || !same(check, data.v.secret)) return json({ error: 'forbidden' }, 403)
      return json({ key_set: !!EL_KEY, signed_url_ok: !!(await signedUrl()) })
    }
    const auth = req.headers.get('authorization') ?? ''
    if (!/^Bearer\s+\S+/i.test(auth)) return json({ error: 'Please sign in again.' }, 401)
    const key = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY')!
    const user = createClient(URL_, key, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
    const body = await req.json().catch(() => ({})) as Record<string, unknown>
    const lat = typeof body.lat === 'number' ? body.lat : null
    const lng = typeof body.lng === 'number' ? body.lng : null
    const { data, error } = await user.rpc('assistant_start', { p_lat: lat, p_lng: lng })
    if (error) return json({ error: /active crew/.test(error.message) ? 'Your crew access is not active.' : 'Please sign in again.' }, 403)
    const st = data as { session_token: string; vars: Record<string, string>; conversations: Conv[] }
    const [signed] = await Promise.all([signedUrl(), fillSummaries(st.conversations)])
    if (!signed) return json({ error: 'The assistant is not available right now. Try again in a minute.' }, 502)
    return json({
      signed_url: signed,
      session_token: st.session_token,
      dynamic_variables: { ...st.vars, session_token: st.session_token, recent_memory: memory(st.conversations) },
    })
  } catch (err) {
    console.error(err)
    return json({ error: 'Could not start the assistant' }, 500)
  }
})
