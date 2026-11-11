// Sends Sparrow Pros emails from the company mailbox (Hostinger SMTP).
// POST { action: "signin", email }                       -> one-time sign-in link (public; only for existing accounts; always answers ok)
// POST { action: "crew_invite", link }   + owner JWT     -> emails the crew invite the owner just made
// POST { action: "contractor_invite", link } + admin JWT -> emails a contractor invite / password link
// POST { action: "verify_email", email }                 -> (re)sends the "confirm your email" link to a new, unconfirmed business (public; always answers ok)
// POST { action: "signup_ready" } + owner JWT            -> after they confirm, tells Sparrow's admins there's a sign-up to approve (once)
// POST { action: "signup_decision", contractor_id } + admin JWT -> emails the business that it was approved or declined
// Links carry a one-time token in the page address (#verify-<type>-<hash>); the app finishes sign-in itself, so no redirect URL setup is needed.
// POST { action: "doc_email", kind: "quote"|"invoice", job_id, email?, note? } + owner JWT -> emails a business's own quote or invoice to its customer
// Secrets: SMTP_PASSWORD. Mailbox settings live in admin.settings.smtp.
// Quotes and invoices can use their own mailbox later (e.g. quote@sparrowlabs.ca): set admin.settings.smtp_docs = {user, host?, port?}
// and the secret SMTP_DOCS_PASSWORD. Until then they go out from the main mailbox.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4'
import nodemailer from 'npm:nodemailer@6.9.16'

const URL_ = Deno.env.get('SUPABASE_URL')!
const db = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })
const PROS = 'https://pros.sparrowlabs.ca/'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

async function sha256(t: string) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// deno-lint-ignore no-explicit-any
let transport: any = null
let fromAddr = ''
async function mailer() {
  if (transport) return transport
  const pass = (Deno.env.get('SMTP_PASSWORD') ?? '').trim()
  if (!pass) throw new Error('Email sending is not set up yet (SMTP_PASSWORD missing).')
  const { data } = await db.schema('admin').from('settings').select('value').eq('key', 'smtp').single()
  const s = data?.value ?? {}
  fromAddr = `"${s.from_name ?? 'Sparrow Pros'}" <${s.user}>`
  transport = nodemailer.createTransport({ host: s.host ?? 'smtp.hostinger.com', port: Number(s.port ?? 465), secure: Number(s.port ?? 465) === 465, auth: { user: s.user, pass } })
  return transport
}

function page(opts: { hello: string; lines: string[]; button: string; url: string; foot: string }) {
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:#0a0a0a">${t}</p>`
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:20px;padding:32px 28px">
<tr><td style="font-size:20px;font-weight:800;letter-spacing:-.02em;color:#0a0a0a;padding-bottom:24px">Sparrow <span style="color:#71717a;font-weight:500;font-size:14px">Pros</span></td></tr>
<tr><td>${p(esc(opts.hello))}${opts.lines.map((l) => p(esc(l))).join('')}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td style="background:#f2541b;border-radius:999px">
<a href="${esc(opts.url)}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:#0a0a0a;text-decoration:none">${esc(opts.button)}</a></td></tr></table>
<p style="margin:0 0 6px;font-size:13px;color:#71717a">Or copy this link into your browser:</p>
<p style="margin:0 0 22px;font-size:12px;color:#71717a;word-break:break-all">${esc(opts.url)}</p>
<p style="margin:0;font-size:13px;color:#71717a;line-height:1.5">${esc(opts.foot)}</p></td></tr></table>
<p style="font-size:12px;color:#a1a1aa;margin:16px 0 0">Sparrow Labs Inc. · British Columbia · This mailbox isn't monitored.</p>
</td></tr></table></body></html>`
}
// mailbox for quotes and invoices (falls back to the main one)
// deno-lint-ignore no-explicit-any
let docTransport: any = null
let docFrom = ''
async function docMailer() {
  if (docTransport) return docTransport
  const { data } = await db.schema('admin').from('settings').select('value').eq('key', 'smtp_docs').maybeSingle()
  const s = data?.value
  const pass = (Deno.env.get('SMTP_DOCS_PASSWORD') ?? '').trim()
  if (s?.user && pass) {
    docFrom = s.user
    docTransport = nodemailer.createTransport({ host: s.host ?? 'smtp.hostinger.com', port: Number(s.port ?? 465), secure: Number(s.port ?? 465) === 465, auth: { user: s.user, pass } })
  } else {
    docTransport = await mailer()
    docFrom = fromAddr.replace(/^.*<|>$/g, '')
  }
  return docTransport
}

const money = (c: number) => '$' + (c / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// deno-lint-ignore no-explicit-any
function docPage(d: any, note: string) {
  const color = /^#[0-9a-f]{6}$/i.test(d.color ?? '') ? d.color : '#0a0a0a'
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  const ink = (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#18181b' : '#ffffff'
  const isQ = d.kind === 'quote'
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:#18181b">${t}</p>`
  const head = d.logo_url ? `<img src="${esc(d.logo_url)}" alt="${esc(d.business)}" style="max-width:180px;max-height:64px;display:block">`
    : `<div style="font-size:22px;font-weight:800;color:#18181b">${esc(d.business)}</div>`
  const amount = isQ ? money(d.total_cents) + ' including GST' : d.status === 'paid' ? 'Paid in full. Thank you!' : money(d.due_cents) + ' due'
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:18px;overflow:hidden">
<tr><td style="height:8px;background:${color}"></td></tr>
<tr><td style="padding:28px 28px 8px">${head}</td></tr>
<tr><td style="padding:12px 28px 28px">
<div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#71717a;margin-bottom:6px">${isQ ? 'Quote' : d.status === 'paid' ? 'Receipt' : 'Invoice'} ${esc(d.ref ?? '')}</div>
<div style="font-size:26px;font-weight:800;color:#18181b;margin-bottom:18px">${esc(amount)}</div>
${p(esc(`Hi${d.customer_first_name ? ' ' + d.customer_first_name : ''},`))}
${p(esc(isQ ? `Here's your quote from ${d.business}${d.job_title ? ' for ' + d.job_title : ''}. You can view it and approve it online.` : `Here's your ${d.status === 'paid' ? 'receipt' : 'invoice'} from ${d.business}${d.job_title ? ' for ' + d.job_title : ''}.${d.status === 'paid' ? '' : ' It shows how to pay.'}`))}
${note ? `<div style="margin:0 0 16px;padding:14px 16px;background:#f4f4f5;border-radius:12px;font-size:15px;line-height:1.5;color:#18181b;white-space:pre-wrap">${esc(note)}</div>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px"><tr><td style="background:${color};border-radius:999px">
<a href="${esc(d.link)}" style="display:inline-block;padding:14px 28px;font-size:16px;font-weight:700;color:${ink};text-decoration:none">${isQ ? 'View and approve quote' : d.status === 'paid' ? 'View receipt' : 'View invoice'}</a></td></tr></table>
<p style="margin:0 0 6px;font-size:13px;color:#71717a">Or copy this link into your browser:</p>
<p style="margin:0 0 20px;font-size:12px;color:#71717a;word-break:break-all">${esc(d.link)}</p>
<p style="margin:0;font-size:14px;color:#52525b;line-height:1.5">Questions? Just reply to this email to reach ${esc(d.contact_name || d.business)}.</p>
</td></tr></table>
<p style="font-size:12px;color:#a1a1aa;margin:16px 0 0">Sent with Sparrow Pros · pros.sparrowlabs.ca</p>
</td></tr></table></body></html>`
}

const text = (o: { hello: string; lines: string[]; url: string; foot: string }) => [o.hello, '', ...o.lines, '', o.url, '', o.foot].join('\n')

async function send(kind: string, to: string, subject: string, o: { hello: string; lines: string[]; button: string; url: string; foot: string }, actor: string | null) {
  try {
    const t = await mailer()
    await t.sendMail({ from: fromAddr, to, subject, html: page(o), text: text(o) })
    await db.schema('admin').from('mail_log').insert({ kind, to_email: to.toLowerCase(), actor, ok: true })
    return null
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 300)
    console.error('send', kind, msg)
    await db.schema('admin').from('mail_log').insert({ kind, to_email: to.toLowerCase(), actor, ok: false, error: msg })
    return msg
  }
}

async function recent(to: string, kind: string, minutes: number) {
  const { count } = await db.schema('admin').from('mail_log').select('id', { count: 'exact', head: true })
    .eq('to_email', to.toLowerCase()).eq('kind', kind).gte('created_at', new Date(Date.now() - minutes * 60e3).toISOString())
  return count ?? 0
}

function userClient(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const key = req.headers.get('apikey') || Deno.env.get('SUPABASE_ANON_KEY')!
  return createClient(URL_, key, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } })
}
function tokenFrom(link: string) {
  const m = /^https:\/\/pros\.sparrowlabs\.ca\/#join-([a-f0-9]{64})$/.exec(String(link ?? '').trim())
  return m ? m[1] : null
}
// one-time sign-in / confirm link that the app completes itself (verifyOtp), so it works without Supabase redirect URL settings
async function appLink(email: string) {
  const { data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email })
  const p = data?.properties
  if (error || !p?.hashed_token) throw new Error(error?.message ?? 'link failed')
  return PROS + 'app/#verify-' + (p.verification_type || 'magiclink') + '-' + p.hashed_token
}
const first = (n: unknown) => String(n ?? '').trim().split(' ')[0]
const when = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { month: 'long', day: 'numeric', timeZone: 'America/Vancouver' })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ ok: false }, 405)
  const body = await req.json().catch(() => ({})) as Record<string, string>
  try {
    if (body.action === 'signin') {
      const email = String(body.email ?? '').trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, message: 'Enter a valid email.' })
      const done = { ok: true, message: `If ${email} has a Sparrow Pros account, a sign-in link is on its way. Check your inbox.` }
      if (await recent(email, 'signin', 15) >= 3) return json(done)
      const { data: who } = await db.rpc('mail_signin_target', { p_email: email })
      if (!who?.user_id) { await db.schema('admin').from('mail_log').insert({ kind: 'signin', to_email: email, ok: false, error: 'no account' }); return json(done) }
      const url = await appLink(email)
      const fail = await send('signin', email, 'Your Sparrow Pros sign-in link', {
        hello: `Hi${who.name ? ' ' + who.name : ''},`,
        lines: ['Tap the button below to sign in to Sparrow Pros. The link works once and expires in 1 hour.'],
        button: 'Sign in to Sparrow Pros', url,
        foot: "If you didn't ask for this, you can ignore this email. Nobody can sign in without the link.",
      }, null)
      if (fail) return json({ ok: false, message: "We couldn't send the email right now. Try again in a few minutes." })
      return json(done)
    }

    if (body.action === 'verify_email') {
      const email = String(body.email ?? '').trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, message: 'Enter a valid email.' })
      const done = { ok: true, message: `We sent a confirmation link to ${email}. Check your inbox (and spam).` }
      if (await recent(email, 'verify_email', 15) >= 3) return json({ ok: false, message: 'We already sent a few links. Wait 15 minutes, then try again.' })
      const { data: uid } = await db.rpc('auth_user_id_by_email', { p_email: email })
      if (!uid) return json(done)
      const { data: au } = await db.auth.admin.getUserById(uid)
      if (!au?.user || au.user.email_confirmed_at) return json({ ok: true, confirmed: true, message: 'Your email is already confirmed. Sign in.' })
      const { data: c } = await db.from('contractors').select('contact_name').eq('user_id', uid).maybeSingle()
      const fail = await send('verify_email', email, 'Confirm your email for Sparrow Pros', {
        hello: `Hi${c?.contact_name ? ' ' + first(c.contact_name) : ''},`,
        lines: ['Thanks for signing up for Sparrow Pros. Tap the button to confirm this is your email.', "Then we'll review your account and email you as soon as it's ready to use, usually within one business day."],
        button: 'Confirm my email', url: await appLink(email),
        foot: "The link works once and expires in 1 hour. If you didn't sign up, you can ignore this email.",
      }, uid)
      if (fail) return json({ ok: false, message: "We couldn't send the email right now. Try again in a few minutes." })
      return json(done)
    }

    if (body.action === 'signup_ready') {
      const uc = userClient(req)
      const { data: u } = await uc.auth.getUser()
      if (!u?.user) return json({ ok: false }, 401)
      if (!u.user.email_confirmed_at) return json({ ok: false, message: 'Email not confirmed yet.' })
      const { data: c } = await db.from('contractors').select('id, business_name, contact_name, phone_e164, email, trade, status, kind').eq('user_id', u.user.id).maybeSingle()
      if (!c || c.kind !== 'subscriber' || c.status !== 'applied') return json({ ok: true })
      const { count } = await db.schema('admin').from('mail_log').select('id', { count: 'exact', head: true }).eq('kind', 'signup_notice').eq('actor', u.user.id)
      if (count) return json({ ok: true })
      const { data: admins } = await db.schema('admin').from('admins').select('user_id, full_name')
      for (const a of admins ?? []) {
        const { data: au } = await db.auth.admin.getUserById(a.user_id)
        if (!au?.user?.email) continue
        await send('signup_notice', au.user.email, `New Sparrow Pros sign-up: ${c.business_name}`, {
          hello: `Hi${a.full_name ? ' ' + first(a.full_name) : ''},`,
          lines: [`${c.business_name} signed up for Sparrow Pros and confirmed their email.`,
            [c.contact_name, c.trade, c.phone_e164, c.email].filter(Boolean).join(' · '),
            'Open the admin dashboard to approve or decline them.'],
          button: 'Review the sign-up', url: 'https://admin.sparrowlabs.ca/#contractors-' + c.id,
          foot: 'You get this email because you are a Sparrow admin.',
        }, u.user.id)
      }
      return json({ ok: true })
    }

    if (body.action === 'signup_decision') {
      const uc = userClient(req)
      const { data: isAdmin } = await uc.rpc('is_admin')
      if (isAdmin !== true) return json({ ok: false, message: 'Admins only.' }, 403)
      const { data: u } = await uc.auth.getUser()
      const { data: c } = await db.from('contractors').select('business_name, contact_name, email, status, status_reason, kind').eq('id', body.contractor_id).maybeSingle()
      if (!c?.email || c.kind !== 'subscriber') return json({ ok: false, message: 'Sign-up not found.' })
      const ok = c.status === 'active'
      if (!ok && c.status !== 'suspended') return json({ ok: false, message: 'Nothing to tell them yet.' })
      const fail = await send(ok ? 'signup_approved' : 'signup_declined', c.email, ok ? `${c.business_name} is ready on Sparrow Pros` : 'About your Sparrow Pros sign-up', ok ? {
        hello: `Hi${c.contact_name ? ' ' + first(c.contact_name) : ''},`,
        lines: [`Good news: ${c.business_name} is approved and ready to use Sparrow Pros.`, 'Sign in to add your logo, your first customer and your first job or quote.', 'Want a hand setting up? Write to info@sparrowlabs.ca and we\'ll walk you through it.'],
        button: 'Open Sparrow Pros', url: PROS + 'app/',
        foot: 'Sign in with the email and password you signed up with. Forgot it? Tap "Email me a sign-in link instead" on the sign-in page.',
      } : {
        hello: `Hi${c.contact_name ? ' ' + first(c.contact_name) : ''},`,
        lines: [`Thanks for signing up ${c.business_name} for Sparrow Pros. We can't open your account right now.`, ...(c.status_reason ? ['Reason: ' + c.status_reason] : []), 'Questions? Write to info@sparrowlabs.ca.'],
        button: 'Visit Sparrow Pros', url: PROS,
        foot: 'Sparrow Labs Inc. · British Columbia',
      }, u?.user?.id ?? null)
      return json(fail ? { ok: false, message: "Saved, but we couldn't send their email." } : { ok: true, message: `Emailed ${c.email}` })
    }

    if (body.action === 'crew_invite' || body.action === 'contractor_invite') {
      const token = tokenFrom(body.link)
      if (!token) return json({ ok: false, message: 'That invite link looks wrong.' })
      const uc = userClient(req)
      const { data: u } = await uc.auth.getUser()
      if (!u?.user) return json({ ok: false, message: 'Please sign in again.' }, 401)
      const hash = await sha256(token)
      const url = PROS + '#join-' + token
      if (body.action === 'crew_invite') {
        const { data: m } = await uc.rpc('mail_crew_invite_info', { p_hash: hash })
        if (!m?.email) return json({ ok: false, message: 'That invite has expired or was already used. Make a new link.' })
        if (await recent(m.email, 'crew_invite', 60) >= 5) return json({ ok: false, message: 'Too many emails to this person. Try again later.' })
        const fail = await send('crew_invite', m.email, `${m.business} added you to their crew`, {
          hello: `Hi ${String(m.full_name).split(' ')[0]},`,
          lines: [`${m.business} added you to their crew on Sparrow Pros.`, "You'll see the jobs you're on, clock in and out, send daily reports and add photos."],
          button: 'Join the crew', url,
          foot: `This link works once and expires on ${when(m.expires_at)}. If you weren't expecting it, you can ignore this email.`,
        }, u.user.id)
        return json(fail ? { ok: false, message: "We couldn't send the email. Copy the link and send it by text instead." } : { ok: true, message: `Invite emailed to ${m.email}` })
      }
      const { data: c, error } = await uc.rpc('mail_contractor_invite_info', { p_hash: hash })
      if (error) return json({ ok: false, message: 'Admins only.' }, 403)
      if (!c?.email) return json({ ok: false, message: 'That link has expired or was already used. Make a new one.' })
      const reset = c.kind === 'reset'
      const fail = await send('contractor_invite', c.email, reset ? 'Set a new Sparrow Pros password' : `You're invited to Sparrow Pros`, {
        hello: `Hi${c.contact_name ? ' ' + String(c.contact_name).split(' ')[0] : ''},`,
        lines: reset ? ['Here is your link to set a new password for Sparrow Pros.']
          : [`Sparrow invited ${c.business} to join Sparrow Pros, where you'll get jobs, send quotes and invoice customers.`, 'Tap the button to create your account.'],
        button: reset ? 'Set my password' : 'Create my account', url,
        foot: `This link works once and expires on ${when(c.expires_at)}. Questions? Reply on WhatsApp or write to info@sparrowlabs.ca.`,
      }, u.user.id)
      return json(fail ? { ok: false, message: "We couldn't send the email. Copy the link and send it instead." } : { ok: true, message: `Emailed to ${c.email}` })
    }
    if (body.action === 'doc_email') {
      const uc = userClient(req)
      const { data: u } = await uc.auth.getUser()
      if (!u?.user) return json({ ok: false, message: 'Please sign in again.' }, 401)
      const kind = body.kind === 'invoice' ? 'invoice' : 'quote'
      const { data: d, error } = await uc.rpc('mail_doc_info', { p_job: body.job_id, p_kind: kind, p_email: body.email || null })
      if (error) return json({ ok: false, message: error.message.replace(/^[a-z]/, (c: string) => c.toUpperCase()) })
      // limit: 40 document emails per business per hour
      const { count } = await db.schema('admin').from('mail_log').select('id', { count: 'exact', head: true })
        .eq('actor', u.user.id).in('kind', ['quote_email', 'invoice_email']).gte('created_at', new Date(Date.now() - 3600e3).toISOString())
      if ((count ?? 0) >= 40) return json({ ok: false, message: 'Too many emails this hour. Try again a bit later.' })
      const note = String(body.note ?? '').trim().slice(0, 1000)
      const subject = kind === 'quote' ? `Quote ${d.ref} from ${d.business}` : `${d.status === 'paid' ? 'Receipt' : 'Invoice'} ${d.ref} from ${d.business}`
      const plain = [`Hi${d.customer_first_name ? ' ' + d.customer_first_name : ''},`, '', kind === 'quote' ? `Here's your quote from ${d.business}:` : `Here's your ${d.status === 'paid' ? 'receipt' : 'invoice'} from ${d.business}:`, d.link, '', ...(note ? [note, ''] : []), `Reply to this email to reach ${d.contact_name || d.business}.`].join('\n')
      try {
        const t = await docMailer()
        const fromName = String(d.business).replace(/["<>]/g, '') + ' via Sparrow Pros'
        await t.sendMail({ from: `"${fromName}" <${docFrom}>`, replyTo: d.reply_to || undefined, to: d.to, subject, html: docPage(d, note), text: plain })
        await db.schema('admin').from('mail_log').insert({ kind: kind + '_email', to_email: String(d.to).toLowerCase(), actor: u.user.id, ok: true })
        return json({ ok: true, message: `Emailed to ${d.to}` })
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 300)
        console.error('doc_email', msg)
        await db.schema('admin').from('mail_log').insert({ kind: kind + '_email', to_email: String(d.to).toLowerCase(), actor: u.user.id, ok: false, error: msg })
        return json({ ok: false, message: /SMTP_PASSWORD/.test(msg) ? "Email isn't switched on yet. Send the link by text for now." : "We couldn't send the email. Try again, or send the link by text." })
      }
    }
    return json({ ok: false, message: 'Unknown action' }, 400)
  } catch (e) {
    console.error(e)
    return json({ ok: false, message: 'Something went wrong. Try again.' }, 500)
  }
})
