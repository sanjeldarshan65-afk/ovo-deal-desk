// OVO Deal Desk: brand-deal CRM + AI copilot + call booking.
// One process, one SQLite file, one dependency (the Anthropic SDK).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

export const STAGES = [
  { id: 'lead', label: 'Lead', prob: 0.1 },
  { id: 'pitched', label: 'Pitched', prob: 0.3 },
  { id: 'negotiating', label: 'Negotiating', prob: 0.6 },
  { id: 'signed', label: 'Signed', prob: 1 },
  { id: 'delivered', label: 'Delivered', prob: 1 },
];
const DAY = 864e5;
const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });

// ---------- database ----------

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY,
      brand TEXT NOT NULL, title TEXT NOT NULL,
      value INTEGER NOT NULL CHECK (value >= 0),
      stage TEXT NOT NULL CHECK (stage IN (${STAGES.map((s) => `'${s.id}'`).join(',')})),
      contact_name TEXT NOT NULL, contact_email TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY,
      deal_id INTEGER NOT NULL REFERENCES deals(id),
      kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY,
      deal_id INTEGER NOT NULL REFERENCES deals(id),
      slot TEXT NOT NULL UNIQUE, -- the double-booking guard lives here, not in app code
      name TEXT NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  if (!db.prepare('SELECT 1 FROM deals LIMIT 1').get()) seed(db);
  return db;
}

function seed(db) {
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
  const rows = [
    ['Nike', 'Spring run club series', 120000, 'negotiating', 'Maya Chen', 2, 'Sent revised rate card. They want usage rights for 12 months, we quoted 6.'],
    ['Strava', 'Segment challenge sponsorship', 60000, 'signed', 'Jonas Weber', 1, 'Contract countersigned. Kickoff call next.'],
    ['Whoop', 'Recovery content bundle', 45000, 'pitched', 'Priya Nair', 9, 'Pitched 3-video bundle. Priya said she would loop in her director.'],
    ['Gymshark', 'Athlete capsule launch', 80000, 'lead', 'Tom Alvarez', 3, 'Inbound via Instagram DM. Asked for media kit.'],
    ['Garmin', 'Marathon training diaries', 35000, 'pitched', 'Elena Rossi', 4, 'Deck sent. Budget sits with the Q1 team.'],
    ['Oakley', 'Summer sunglasses spots', 25000, 'negotiating', 'Sam Okafor', 12, 'They pushed back on price. Offered to drop one deliverable.'],
    ['Red Bull', 'Event recap film', 90000, 'lead', 'Lena Fischer', 0, 'Met at the Austin event. Wants a one-pager.'],
    ['Hoka', 'Trail shoe review series', 30000, 'delivered', 'Chris Park', 20, 'All four videos live. Invoice paid.'],
  ];
  const deal = db.prepare('INSERT INTO deals (brand,title,value,stage,contact_name,contact_email,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
  const act = db.prepare('INSERT INTO activities (deal_id,kind,body,created_at) VALUES (?,?,?,?)');
  for (const [brand, title, value, stage, contact, days, note] of rows) {
    const email = `${contact.split(' ')[0].toLowerCase()}@example.com`;
    const { lastInsertRowid: id } = deal.run(brand, title, value, stage, contact, email, ago(days + 14), ago(days));
    act.run(id, 'note', note, ago(days));
  }
}

// ---------- booking slots ----------

// Next 5 weekdays, hourly 10:00-16:00, in the server's timezone (shown on the booking page).
// ponytail: times are not converted per viewer. Store UTC + render in the visitor's zone when brands book across zones.
export const TIMEZONE = (() => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const short = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts().find((p) => p.type === 'timeZoneName').value;
  return `${zone.replaceAll('_', ' ')} time (${short})`;
})();
export function slots(from = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const out = [];
  const d = new Date(from);
  while (out.length < 35) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    for (let h = 10; h <= 16; h++) out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:00`);
  }
  return out;
}

// ---------- AI copilot ----------

const COPILOT_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', description: 'Chance this deal closes, 0-100' },
    reasoning: { type: 'string', description: 'Two sentences max, citing the notes' },
    next_action: { type: 'string', description: 'The single most useful thing to do today' },
    email_subject: { type: 'string' },
    email_body: { type: 'string', description: 'Ready to send, under 120 words, plain text' },
  },
  required: ['score', 'reasoning', 'next_action', 'email_subject', 'email_body'],
  additionalProperties: false,
};

const COPILOT_SYSTEM = `You are the deal desk copilot for OVO, a company that closes brand partnership deals (sponsorships, content packages, event activations).
You get one deal as JSON: its stage, value, days since last touch, the activity log, and any booked calls.
Judge how likely it is to close, name the single next action, and draft the email that performs that action.
If booked_calls has an upcoming call, never ask the contact to book another: build the next action and the email around that call.
Only when no call is booked may the email invite one, using the literal text {booking_link} as the link.
Find the specific open issue in the latest notes (a disputed term, a missing approval, a requested document) and make the draft about resolving it.
Base everything on the activity log: quote specifics from it, never invent facts, prices or commitments that are not there.
Write the email the way a sharp partnerships lead would: short, specific, one clear ask, no filler. Sign off as "OVO Partnerships".`;

// Deterministic stand-in so the product still works with no API key (and so tests never hit the network).
export function heuristicCopilot({ deal, activities, bookings }) {
  const stage = STAGES.find((s) => s.id === deal.stage);
  const quiet = Math.floor((Date.now() - new Date(deal.updated_at)) / DAY);
  const call = bookings.find((b) => b.slot > now().slice(0, 16));
  const closed = stage.prob === 1;
  // Rounded to 5 so a rule of thumb does not read like a measurement.
  const score = closed ? 100 : Math.max(5, Math.min(95, Math.round((stage.prob * 100 - Math.min(30, quiet * 2) + (call ? 10 : 0)) / 5) * 5));
  const note = activities.find((a) => a.kind === 'note')?.body;
  const callWhen = call && new Date(call.slot).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const first = deal.contact_name.split(' ')[0];
  const plays = {
    lead: ['Send the media kit and propose a 20-minute intro call.', `Media kit + quick intro: ${deal.title}`, `Great to connect. I've attached our media kit with audience numbers and past brand work.\n\nDo you have 20 minutes this week to talk through "${deal.title}"? You can grab a slot here: {booking_link}`],
    pitched: ['Follow up on the pitch and ask who else needs to sign off.', `Following up: ${deal.title}`, `Wanted to check where "${deal.title}" landed on your side. If it helps, I can send a one-page version for whoever else needs to sign off.\n\nHappy to walk through it live: {booking_link}`],
    negotiating: ['Get on a call to close the open terms instead of trading emails.', `Closing out terms: ${deal.title}`, `I think we're close on "${deal.title}". Rather than another round of email, can we take 20 minutes to settle the open points and get paper out this week?\n\nPick a time here: {booking_link}`],
    signed: ['Send the kickoff brief and lock deliverable dates.', `Kickoff: ${deal.title}`, `Excited to get "${deal.title}" moving. I'll send the kickoff brief with deliverable dates today. Let's do a short kickoff call to confirm them: {booking_link}`],
    delivered: ['Share results and open the renewal conversation.', `Results + what's next: ${deal.title}`, `"${deal.title}" is wrapped. I'm putting together a results recap for you this week.\n\nWhile it's fresh, I'd love to talk about what a follow-up could look like: {booking_link}`],
  };
  // A call already on the calendar changes the play: prepare for it, never ask for a second one.
  const [next_action, email_subject, body] = call
    ? [`Prepare for the call on ${callWhen}${note ? `. Open item from the log: "${note}"` : ' and send an agenda.'}`,
       `Ahead of our call: ${deal.title}`,
       `Looking forward to speaking on ${callWhen}.\n\nSo we use the 20 minutes well, I'll come with a concrete proposal on the open points for "${deal.title}", and we can aim to leave with agreed terms. If there is anything you want covered, reply here and I'll add it.`]
    : plays[deal.stage];
  return {
    score,
    reasoning: closed
      ? 'This deal is already signed, so the work now is delivery and renewal.'
      : `${stage.label} deals close about ${stage.prob * 100}% of the time. ${quiet >= 7 ? `It has been quiet for ${quiet} days, which drags the odds down.` : 'It was touched recently, so momentum is intact.'}${call ? ` A call is booked for ${callWhen}, which helps.` : ''}`,
    next_action,
    email_subject,
    email_body: `Hi ${first},\n\n${body}\n\nOVO Partnerships`,
    source: 'heuristic',
  };
}

let anthropic;
export async function copilot(ctx) {
  try {
    anthropic ??= new Anthropic();
    const { deal, activities, bookings } = ctx;
    const msg = await anthropic.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: COPILOT_SCHEMA } },
      system: COPILOT_SYSTEM,
      messages: [{
        role: 'user',
        content: JSON.stringify({
          deal: { ...deal, days_since_last_touch: Math.floor((Date.now() - new Date(deal.updated_at)) / DAY) },
          activity_log: activities.map(({ kind, body, created_at }) => ({ kind, body, created_at })),
          booked_calls: bookings.map((b) => b.slot),
          booking_link_placeholder: '{booking_link}',
        }),
      }],
    });
    if (msg.stop_reason !== 'end_turn') throw new Error(`stopped: ${msg.stop_reason}`);
    return { ...JSON.parse(msg.content.find((b) => b.type === 'text').text), source: 'claude' };
  } catch (e) {
    if (!(e instanceof Anthropic.AuthenticationError)) console.error('copilot fell back to heuristic:', e.message);
    return heuristicCopilot(ctx);
  }
}

// ---------- http ----------

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e5) throw fail(413, 'Body too large');
  }
  try {
    const body = JSON.parse(raw || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw fail(400, 'Body must be a JSON object');
}

const text = (v, name, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw fail(400, `${name} is required (max ${max} chars)`);
  return v.trim();
};
const email = (v) => {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text(v, 'email'))) throw fail(400, 'email is not valid');
  return v.trim();
};

export function createServer(db, ai = copilot) {
  const getDeal = (id) => db.prepare('SELECT * FROM deals WHERE id = ?').get(id) ?? (() => { throw fail(404, 'Deal not found'); })();
  const context = (id) => ({
    deal: getDeal(id),
    activities: db.prepare('SELECT * FROM activities WHERE deal_id = ? ORDER BY created_at DESC, id DESC').all(id),
    bookings: db.prepare('SELECT * FROM bookings WHERE deal_id = ? ORDER BY slot').all(id),
  });
  const log = (id, kind, body) => {
    db.prepare('INSERT INTO activities (deal_id,kind,body,created_at) VALUES (?,?,?,?)').run(id, kind, body, now());
    db.prepare('UPDATE deals SET updated_at = ? WHERE id = ?').run(now(), id);
  };

  const routes = [
    ['GET', /^\/api\/deals$/, () => ({
      stages: STAGES,
      deals: db.prepare(`SELECT d.*, (SELECT MIN(slot) FROM bookings b WHERE b.deal_id = d.id AND b.slot > ?) AS next_call
                         FROM deals d ORDER BY d.value DESC`).all(now().slice(0, 16)),
    })],
    ['POST', /^\/api\/deals$/, async (_, req) => {
      const b = await readJson(req);
      if (!Number.isInteger(b.value) || b.value < 0 || b.value > 1e9) throw fail(400, 'value must be a whole dollar amount');
      const { lastInsertRowid: id } = db.prepare('INSERT INTO deals (brand,title,value,stage,contact_name,contact_email,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(text(b.brand, 'brand'), text(b.title, 'title'), b.value, 'lead', text(b.contact_name, 'contact_name'), email(b.contact_email), now(), now());
      log(id, 'stage', 'Deal created');
      return getDeal(id);
    }],
    ['GET', /^\/api\/deals\/(\d+)$/, ([id]) => context(id)],
    ['PATCH', /^\/api\/deals\/(\d+)$/, async ([id], req) => {
      const { stage } = await readJson(req);
      const to = STAGES.find((s) => s.id === stage);
      if (!to) throw fail(400, `stage must be one of: ${STAGES.map((s) => s.id).join(', ')}`);
      if (getDeal(id).stage !== stage) {
        db.prepare('UPDATE deals SET stage = ? WHERE id = ?').run(stage, id);
        log(id, 'stage', `Moved to ${to.label}`);
      }
      return getDeal(id);
    }],
    ['POST', /^\/api\/deals\/(\d+)\/notes$/, async ([id], req) => {
      getDeal(id);
      log(id, 'note', text((await readJson(req)).body, 'body', 2000));
      return context(id);
    }],
    ['POST', /^\/api\/deals\/(\d+)\/copilot$/, ([id]) => ai(context(id))],

    // Public booking page API: exposes brand + title only, never value or notes.
    ['GET', /^\/api\/book\/(\d+)$/, ([id]) => {
      const { brand, title } = getDeal(id);
      const taken = new Set(db.prepare('SELECT slot FROM bookings').all().map((r) => r.slot));
      return { brand, title, timezone: TIMEZONE, slots: slots().map((slot) => ({ slot, taken: taken.has(slot) })) };
    }],
    ['POST', /^\/api\/book\/(\d+)$/, async ([id], req) => {
      getDeal(id);
      const b = await readJson(req);
      if (!slots().includes(b.slot)) throw fail(400, 'That time is not available');
      const who = text(b.name, 'name');
      try {
        db.prepare('INSERT INTO bookings (deal_id,slot,name,email,created_at) VALUES (?,?,?,?,?)').run(id, b.slot, who, email(b.email), now());
      } catch (e) {
        if (e.status) throw e;
        if (/UNIQUE/.test(e.message)) throw fail(409, 'That time was just taken. Pick another.');
        throw e;
      }
      log(id, 'call', `${who} booked a call for ${b.slot.replace('T', ' at ')}`);
      return { slot: b.slot, timezone: TIMEZONE };
    }],
  ];

  const pages = [[/^\/$/, 'index.html'], [/^\/book\/\d+$/, 'book.html']];
  const publicDir = new URL('./public/', import.meta.url);

  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      const page = req.method === 'GET' && pages.find(([re]) => re.test(pathname));
      if (page) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(await readFile(new URL(page[1], publicDir)));
      }
      for (const [method, re, handler] of routes) {
        const m = req.method === method && pathname.match(re);
        if (!m) continue;
        const out = await handler(m.slice(1).map(Number), req);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(out));
      }
      throw fail(404, 'Not found');
    } catch (e) {
      if (!e.status) console.error(e);
      res.writeHead(e.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.status ? e.message : 'Server error' }));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT ?? 3000;
  // ponytail: no auth, this is a single-user local tool. Put a login in front before it leaves localhost.
  createServer(openDb(fileURLToPath(new URL('./deals.db', import.meta.url))))
    .listen(port, '127.0.0.1', () => console.log(`OVO Deal Desk → http://localhost:${port}`));
}
