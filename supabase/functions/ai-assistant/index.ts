// Sparrow Pros assistant (Claude). One endpoint for crew and for business owners.
// POST { message, conversation_id?, lat?, lng? } with the user's sign-in token.
// Every tool runs as the signed-in person (their token), so the database's own rules decide what they may do.
// Secret: ANTHROPIC_API_KEY.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4'

const URL_ = Deno.env.get('SUPABASE_URL')!
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const KEY = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim()
const MODELS = { crew: 'claude-haiku-5-5', owner: 'claude-sonnet-5-5' } as const
const DAILY_LIMIT = { crew: 150, owner: 300 }
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

type Kind = 'crew' | 'owner'
type Tool = { name: string; description: string; input_schema: Record<string, unknown>; write?: boolean }
// deno-lint-ignore no-explicit-any
type Any = any

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required })
const S = (d: string) => ({ type: 'string', description: d })
const DATE = (d: string) => ({ type: 'string', description: d + ' (YYYY-MM-DD)' })

const CREW_TOOLS: Tool[] = [
  { name: 'get_my_day', description: 'Refresh their jobs, shifts, clock status, problem reports and time off.', input_schema: obj({}) },
  { name: 'clock_in', description: 'Clock them in now. Pass job_id when they said which job, otherwise leave it out.', input_schema: obj({ job_id: S('Job id from the context') }), write: true },
  { name: 'clock_out', description: 'Clock them out now.', input_schema: obj({}), write: true },
  { name: 'send_daily_report', description: "Save today's report for a job (work done, progress, issues). Shared with the crew on that job.", input_schema: obj({ job_id: S('Job id; leave out to use the job they are on'), text: S('The report in clear sentences') }, ['text']), write: true },
  { name: 'report_problem', description: 'Tell the boss about a problem: materials, safety, delay, equipment, customer, other.', input_schema: obj({ job_id: S('Job id if known'), type: { type: 'string', enum: ['material', 'safety', 'delay', 'equipment', 'customer', 'other'] }, urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: 'high if someone could get hurt, work is stopped or it is needed today' }, description: S("What's wrong and what's needed") }, ['type', 'urgency', 'description']), write: true },
  { name: 'flag_low_stock', description: 'Flag a tool or supply as low or out, on a truck or in the yard.', input_schema: obj({ item: S('e.g. deck screws'), location_name: S('e.g. Truck 2 or Yard'), status: { type: 'string', enum: ['low', 'out'] } }, ['item']), write: true },
  { name: 'request_time_off', description: 'Ask for days off. The app approves it automatically if asked early enough with nothing booked.', input_schema: obj({ start_date: DATE('First day off'), end_date: DATE('Last day off'), reason: S('Reason if given') }, ['start_date']), write: true },
  { name: 'message_boss', description: 'Send a written message to their boss in the Messages tab.', input_schema: obj({ text: S('The message') }, ['text']), write: true },
  { name: 'read_messages', description: 'Read recent messages from their boss (and notes sent to the whole crew).', input_schema: obj({}) },
]

const OWNER_TOOLS: Tool[] = [
  { name: 'get_week', description: 'Shifts, crew, time off and jobs for 7 days starting on a date.', input_schema: obj({ start_date: DATE('First day, usually the Monday') }, ['start_date']) },
  { name: 'save_shift', description: 'Add a shift, or change one when shift_id is given.', input_schema: obj({ shift_id: S('Only when changing an existing shift'), member_id: S('Crew member id'), job_id: S('Job id, optional'), date: DATE('Day of the shift'), start_time: S('HH:MM, 24h'), end_time: S('HH:MM, 24h'), notes: S('Optional note for the crew member') }, ['member_id', 'date', 'start_time', 'end_time']), write: true },
  { name: 'remove_shift', description: 'Remove a shift.', input_schema: obj({ shift_id: S('Shift id') }, ['shift_id']), write: true },
  { name: 'get_updates', description: "Who is on the clock or late, crew problem reports, time-off requests, daily reports, low stock.", input_schema: obj({}) },
  { name: 'set_problem_status', description: 'Mark a crew problem report as seen or resolved.', input_schema: obj({ alert_id: S('Problem id'), status: { type: 'string', enum: ['seen', 'resolved'] } }, ['alert_id', 'status']), write: true },
  { name: 'decide_time_off', description: 'Approve or decline a time-off request.', input_schema: obj({ request_id: S('Request id'), approve: { type: 'boolean' } }, ['request_id', 'approve']), write: true },
  { name: 'get_timesheets', description: 'Clocked hours between two dates.', input_schema: obj({ from: DATE('From'), to: DATE('To') }, ['from', 'to']) },
  { name: 'list_jobs', description: 'Their open and recent jobs: ref, service, status, day, address, crew.', input_schema: obj({}) },
  { name: 'get_calendar', description: 'Their calendar (jobs, site visits, blocked days, own jobs) between two dates.', input_schema: obj({ from: DATE('From'), to: DATE('To') }, ['from', 'to']) },
  { name: 'set_job_crew', description: 'Choose which crew members are on a job (replaces the list).', input_schema: obj({ job_id: S('Job id'), member_ids: { type: 'array', items: { type: 'string' } } }, ['job_id', 'member_ids']), write: true },
  { name: 'message_crew', description: 'Send a message to one crew member, or to everyone when member_id is left out.', input_schema: obj({ member_id: S('Crew member id; leave out for everyone'), text: S('The message') }, ['text']), write: true },
  { name: 'read_messages', description: 'Read the message thread with one crew member.', input_schema: obj({ member_id: S('Crew member id') }, ['member_id']) },
]

const clip = (v: unknown, n = 6000) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…(cut)' : s }

// Make the big job objects small before the model sees them
function slimJob(j: Any) {
  return { id: j.id, ref: j.ref, service: j.service ?? j.service_name, status: j.status, day: j.day, time: j.preferred_time ?? undefined,
    address: [j.unit, j.address_line, j.city].filter(Boolean).join(', ') || undefined, crew: j.crew, customer: j.customer_first_name ?? j.customer_name ?? undefined }
}

async function runTool(kind: Kind, name: string, a: Any, db: SupabaseClient, ctx: { lat: number | null; lng: number | null }) {
  const rpc = async (fn: string, args?: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args ?? {})
    if (error) throw new Error(error.message)
    return data
  }
  const day = (x: string | undefined) => (x && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : undefined)
  if (kind === 'crew') {
    switch (name) {
      case 'get_my_day': { const d = await rpc('crew_home'); return { ...d, jobs: (d.jobs ?? []).map(slimJob), shifts: (d.shifts ?? []).map((s: Any) => ({ ...s, job: s.job ? slimJob(s.job) : null })) } }
      case 'clock_in': { const d = await rpc('crew_clock_in', { p_job: a.job_id || null, p_lat: ctx.lat, p_lng: ctx.lng }); return { ok: true, open_entry: d.open_entry } }
      case 'clock_out': { const d = await rpc('crew_clock_out', { p_lat: ctx.lat, p_lng: ctx.lng }); return { ok: true, last_entry: d.last_entry, reported_today: d.reported_today } }
      case 'send_daily_report': await rpc('crew_daily_report', { p_job: a.job_id || null, p_body: a.text }); return { ok: true }
      case 'report_problem': await rpc('crew_raise_alert', { p_job: a.job_id || null, p_type: a.type, p_urgency: a.urgency, p_body: a.description }); return { ok: true, note: 'The boss sees it on their Updates screen.' }
      case 'flag_low_stock': await rpc('crew_flag_stock', { p_location: null, p_location_name: a.location_name || null, p_item: a.item, p_status: a.status || 'low' }); return { ok: true }
      case 'request_time_off': { const d = await rpc('crew_request_time_off', { p_start: day(a.start_date), p_end: day(a.end_date) ?? day(a.start_date), p_reason: a.reason || null }); return { ok: true, auto_approved: d.auto_approved, clashes: d.clashes, notice_days: d.notice_days } }
      case 'message_boss': await rpc('crew_msg_send', { p_body: a.text }); return { ok: true }
      case 'read_messages': { const d = await rpc('crew_messages'); return { boss: d.boss, messages: (d.messages ?? []).slice(-15) } }
    }
  } else {
    switch (name) {
      case 'get_week': { const f = day(a.start_date)!; const t = new Date(Date.parse(f) + 6 * 86400e3).toISOString().slice(0, 10); return await rpc('owner_board', { p_from: f, p_to: t }) }
      case 'save_shift': {
        const st = await rpc('van_ts', { p_date: day(a.date), p_time: a.start_time })
        let en = await rpc('van_ts', { p_date: day(a.date), p_time: a.end_time })
        if (Date.parse(en) <= Date.parse(st)) en = new Date(Date.parse(en) + 86400e3).toISOString()
        return await rpc('shift_save', { p: { id: a.shift_id || '', member_id: a.member_id, job_id: a.job_id || '', starts_at: st, ends_at: en, notes: a.notes || '' } })
      }
      case 'remove_shift': await rpc('shift_remove', { p_shift: a.shift_id }); return { ok: true }
      case 'get_updates': return await rpc('owner_updates')
      case 'set_problem_status': await rpc('alert_set_status', { p_alert: a.alert_id, p_status: a.status }); return { ok: true }
      case 'decide_time_off': await rpc('time_off_decide', { p_request: a.request_id, p_approve: !!a.approve }); return { ok: true }
      case 'get_timesheets': { const d = await rpc('owner_timesheets', { p_from: day(a.from), p_to: day(a.to) }); return d }
      case 'list_jobs': { const d = await rpc('contractor_jobs'); return (Array.isArray(d) ? d : d.jobs ?? []).slice(0, 60).map(slimJob) }
      case 'get_calendar': return await rpc('contractor_calendar', { p_from: day(a.from), p_to: day(a.to) })
      case 'set_job_crew': await rpc('job_set_crew', { p_job: a.job_id, p_members: a.member_ids ?? [] }); return { ok: true }
      case 'message_crew': await rpc('msg_send', { p_member: a.member_id || null, p_body: a.text }); return { ok: true }
      case 'read_messages': { const d = await rpc('msg_thread', { p_member: a.member_id }); return { member: d.member, messages: (d.messages ?? []).slice(-30) } }
    }
  }
  throw new Error('unknown tool')
}

function system(kind: Kind, ctx: Any) {
  const common = `Today is ${ctx.local_time} (Vancouver time). Keep replies short and plain: one to three sentences unless they ask for a list. Use the tools; never invent jobs, times, ids, statuses or confirmations. Never show ids to the user; use names, job refs and dates. If a tool returns an error, explain it simply and say what's needed.
Before any action that changes something (marked as an action), say in one line exactly what you will do and wait for a yes, unless the user already clearly asked for that exact thing in their last message.`
  if (kind === 'crew') return `You are the assistant in the Sparrow Pros crew app for ${ctx.business}. You help ${ctx.name}, a crew member working in the field, often on a phone with dirty hands.
${common}
What you know now (it may be a few minutes old; call get_my_day for fresh data):
${clip(ctx.snapshot, 5000)}
- If they have more than one job today and it's unclear which one, ask before clocking in or sending a report.
- After clock_out, if that job isn't in reported_today, offer to send today's report.
- Photos are added from the job screen or the camera button; a message like "[2 photos added to the job: …]" means it's done.
- You can't see other crew members' details, pay, prices or customers' phone numbers.`
  return `You are the assistant for ${ctx.name}, the owner of ${ctx.business}, inside Sparrow Pros. You help them run their crew and schedule: plan shifts, check who's working, deal with problem reports and time off, check hours, assign crew to jobs and message the crew.
${common}
Their crew (use these ids with the tools): ${clip(ctx.crew, 2500)}
- For "this week" use the Monday of the current week. Shifts use 24h times in Vancouver time.
- When planning several shifts, list them first and get one yes for the whole set.
- Quotes, prices and invoices are done on the Jobs screen; point them there if asked.`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method' }, 405)
  try {
    const check = req.headers.get('x-ops-check')
    if (check) {
      const { data } = await admin.from('ops_kv').select('v').eq('k', 'el_relay').single()
      if (check !== data?.v?.secret) return json({ error: 'forbidden' }, 403)
      return json({ key_set: !!KEY })
    }
    const auth = req.headers.get('authorization') ?? ''
    if (!/^Bearer\s+\S+/i.test(auth)) return json({ error: 'Please sign in again.' }, 401)
    const apikey = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY')!
    const db = createClient(URL_, apikey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
    const { data: u } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ''))
    if (!u?.user) return json({ error: 'Please sign in again.' }, 401)
    if (!KEY) return json({ error: 'The assistant is not switched on yet.' }, 503)

    const body = await req.json().catch(() => ({})) as Any
    const message = String(body.message ?? '').trim().slice(0, 4000)
    if (!message) return json({ error: 'Type a message first.' }, 400)
    const loc = { lat: typeof body.lat === 'number' ? body.lat : null, lng: typeof body.lng === 'number' ? body.lng : null }

    const { data: who, error: we } = await db.rpc('app_whoami')
    if (we) throw new Error(we.message)
    let kind: Kind; let contractorId: string; let memberId: string | null = null
    const ctx: Any = {}
    const { data: lt } = await admin.rpc('van_now_text')
    ctx.local_time = lt ?? new Date().toISOString()
    if (who?.kind === 'crew') {
      kind = 'crew'; memberId = who.member_id
      const [{ data: me }, { data: home }] = await Promise.all([db.rpc('crew_me'), db.rpc('crew_home')])
      ctx.name = me?.member?.full_name?.split(' ')[0] ?? 'there'; ctx.business = me?.business?.name ?? 'the business'
      contractorId = (await admin.from('team_members').select('contractor_id').eq('id', memberId).single()).data?.contractor_id
      ctx.snapshot = home ? { clocked_in: home.open_entry, today_hours: home.today_hours, jobs: (home.jobs ?? []).map(slimJob), shifts: (home.shifts ?? []).slice(0, 12).map((s: Any) => ({ id: s.id, day: s.day, starts_at: s.starts_at, ends_at: s.ends_at, job_id: s.job_id, notes: s.notes })), reported_today: home.reported_today, problems: (home.alerts ?? []).slice(0, 5), time_off: home.time_off, locations: home.locations, time_off_notice_days: home.notice_days } : {}
    } else if (who?.kind === 'owner') {
      kind = 'owner'; contractorId = who.contractor_id
      const [{ data: me }, { data: team }] = await Promise.all([db.rpc('contractor_me'), db.rpc('team_list')])
      const c = me?.contractor ?? me ?? {}
      ctx.name = String(c.contact_name ?? '').split(' ')[0] || 'there'; ctx.business = c.invoice_display_name ?? c.business_name ?? 'their business'
      ctx.crew = (Array.isArray(team) ? team : team?.team ?? []).map((m: Any) => ({ id: m.id, name: m.full_name, active: m.active, joined: !!m.joined_at || m.status === 'joined' }))
    } else return json({ error: 'Please sign in again.' }, 403)

    // daily limit
    const since = new Date(Date.now() - 86400e3).toISOString()
    const { data: convs } = await admin.from('ai_conversations').select('id').eq('user_id', u.user.id).gte('last_at', since)
    if (convs?.length) {
      const { count } = await admin.from('ai_messages').select('id', { count: 'exact', head: true }).in('conversation_id', convs.map((c) => c.id)).eq('role', 'user').gte('created_at', since)
      if ((count ?? 0) >= DAILY_LIMIT[kind]) return json({ error: "You've reached today's assistant limit. It resets tomorrow." }, 429)
    }

    // conversation
    let convId: string | null = typeof body.conversation_id === 'string' ? body.conversation_id : null
    if (convId) {
      const { data: c } = await admin.from('ai_conversations').select('id,user_id,last_at').eq('id', convId).maybeSingle()
      if (!c || c.user_id !== u.user.id || Date.now() - Date.parse(c.last_at) > 12 * 3600e3) convId = null
    }
    if (!convId) {
      const { data: c, error } = await admin.from('ai_conversations').insert({ user_id: u.user.id, kind, contractor_id: contractorId, member_id: memberId }).select('id').single()
      if (error) throw error
      convId = c.id
    }
    const { data: past } = await admin.from('ai_messages').select('role,body').eq('conversation_id', convId).order('id', { ascending: false }).limit(20)
    const history = (past ?? []).reverse().map((m) => ({ role: m.role, content: m.body }))
    while (history.length && history[0].role !== 'user') history.shift()
    await admin.from('ai_messages').insert({ conversation_id: convId, role: 'user', body: message })

    const tools = kind === 'crew' ? CREW_TOOLS : OWNER_TOOLS
    const messages: Any[] = [...history, { role: 'user', content: message }]
    const actions: { tool: string; ok: boolean; error?: string }[] = []
    let reply = ''; let inTok = 0; let outTok = 0
    for (let step = 0; step < 8; step++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: MODELS[kind], max_tokens: 1024, system: system(kind, ctx), tools: tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })), messages }),
      })
      const res = await r.json()
      if (!r.ok) { console.error('anthropic', r.status, JSON.stringify(res).slice(0, 400)); throw new Error('assistant unavailable') }
      inTok += res.usage?.input_tokens ?? 0; outTok += res.usage?.output_tokens ?? 0
      const text = (res.content ?? []).filter((b: Any) => b.type === 'text').map((b: Any) => b.text).join('\n').trim()
      if (res.stop_reason !== 'tool_use') { reply = text; break }
      messages.push({ role: 'assistant', content: res.content })
      const results: Any[] = []
      for (const b of res.content ?? []) {
        if (b.type !== 'tool_use') continue
        try {
          const out = await runTool(kind, b.name, b.input ?? {}, db, loc)
          if (tools.find((t) => t.name === b.name)?.write) actions.push({ tool: b.name, ok: true })
          results.push({ type: 'tool_result', tool_use_id: b.id, content: clip(out) })
        } catch (e) {
          const msg = String((e as Error)?.message ?? e).slice(0, 300)
          if (tools.find((t) => t.name === b.name)?.write) actions.push({ tool: b.name, ok: false, error: msg })
          results.push({ type: 'tool_result', tool_use_id: b.id, content: 'Error: ' + msg, is_error: true })
        }
      }
      messages.push({ role: 'user', content: results })
      if (step === 7) reply = text || 'Sorry, that took too many steps. Could you say it more simply?'
    }
    if (!reply) reply = 'Done.'
    await admin.from('ai_messages').insert({ conversation_id: convId, role: 'assistant', body: reply, actions: actions.length ? actions : null, input_tokens: inTok, output_tokens: outTok })
    await admin.from('ai_conversations').update({ last_at: new Date().toISOString() }).eq('id', convId)
    return json({ conversation_id: convId, reply, actions })
  } catch (err) {
    console.error(err)
    return json({ error: 'The assistant had a problem. Try again in a moment.' }, 500)
  }
})
