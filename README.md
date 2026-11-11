# OVO Deal Desk

A small working version of the three things in the job post: the CRM, the AI that helps close brand deals, and the booking system.

```bash
npm install
```

```bash
npm start
```

Open http://localhost:3000. `npm test` runs the check.

## What it does

- **Pipeline board.** Drag a deal between stages. The header shows open pipeline, a stage-weighted forecast, and booked calls. Deals with no touch in 7+ days get flagged.
- **Copilot.** Open a deal and hit "Draft my next move". Claude reads the deal's activity log and returns a close score, the one next action, and a ready-to-send email with the booking link in it. With no `ANTHROPIC_API_KEY` set it falls back to a rules engine, so the demo never dead-ends.
- **Booking.** Every deal has a public link (`/book/:id`). The brand contact picks a slot; it lands on the deal's timeline and the board.

## Decisions worth a look

- **One dependency.** Node's built-in `http` and `sqlite`, plus the Anthropic SDK. No framework, no build step, ~300 lines of server.
- **Double-booking is a database constraint**, `UNIQUE(slot)`, not an app-level check, so two simultaneous requests cannot both win.
- **The public booking API returns brand and title only.** Deal value and notes never leave the internal routes (covered by the test).
- **Copilot output is schema-constrained JSON**, and the prompt forbids inventing prices or commitments that are not in the log.

## Known limits

- No auth. It binds to 127.0.0.1 only; it needs a login before it goes anywhere else.
- Slots are server-local time, no timezone handling.
- Seed data is invented. Delete `deals.db` to reset it.
