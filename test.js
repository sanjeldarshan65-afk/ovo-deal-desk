// One runnable check for the paths that would hurt if they broke: validation, stage moves, double-booking.
import assert from 'node:assert/strict';
import { openDb, createServer, heuristicCopilot, slots } from './server.js';

const server = createServer(openDb(':memory:'), heuristicCopilot).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, body: body && JSON.stringify(body) });
  return [r.status, await r.json()];
};

try {
  const good = { brand: 'Acme', title: 'Test deal', value: 5000, contact_name: 'Ana Ruiz', contact_email: 'ana@example.com' };
  assert.equal((await call('POST', '/api/deals', { ...good, value: -1 }))[0], 400);
  assert.equal((await call('POST', '/api/deals', { ...good, contact_email: 'nope' }))[0], 400);
  const [, deal] = await call('POST', '/api/deals', good);
  assert.equal(deal.stage, 'lead');

  assert.equal((await call('PATCH', `/api/deals/${deal.id}`, { stage: 'won' }))[0], 400);
  assert.equal((await call('PATCH', `/api/deals/${deal.id}`, { stage: 'pitched' }))[1].stage, 'pitched');
  assert.equal((await call('GET', '/api/deals/9999'))[0], 404);

  const [slot] = slots();
  const booking = { slot, name: 'Ana Ruiz', email: 'ana@example.com' };
  assert.equal((await call('POST', `/api/book/${deal.id}`, { ...booking, slot: '2020-01-01T10:00' }))[0], 400);
  assert.equal((await call('POST', `/api/book/${deal.id}`, booking))[0], 200);
  assert.equal((await call('POST', '/api/book/1', booking))[0], 409, 'same slot cannot be booked twice, even for another deal');

  const [, pub] = await call('GET', `/api/book/${deal.id}`);
  assert.equal(pub.slots[0].taken, true);
  assert.equal('value' in pub, false, 'public booking API must not leak deal value');

  const [, ctx] = await call('GET', `/api/deals/${deal.id}`);
  assert.deepEqual(ctx.activities.map((a) => a.kind).sort(), ['call', 'stage', 'stage']);

  const [, ai] = await call('POST', `/api/deals/${deal.id}/copilot`);
  assert.ok(ai.score > 0 && ai.score <= 100 && ai.email_body.includes('Ana'));
  assert.ok(!ai.email_body.includes('{booking_link}') && /call on/i.test(ai.next_action), 'a deal with a call booked must not be asked to book another');
  assert.ok(pub.timezone, 'booking page must be told which timezone the slots are in');
  console.log('ok');
} finally {
  server.close();
}
