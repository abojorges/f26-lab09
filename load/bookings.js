// Claim: a room slot is booked at most once.
//
// For each slot, asks copy A to book it, then asks copy B to book the same
// room and slot for a different user. If the platform held one set of
// bookings, B would find the slot taken and put its user on the waitlist
// (202). The run fails if B confirms (201) a slot A already confirmed.
//
// The requests go to each copy directly, not through the proxy. Through the
// proxy a token only works on the copy that issued it (load/tokens.js), so
// about half the posts would stop at a 401 before reaching the room check.
// The two users differ so that the room check is the only thing that can
// stop B: with one store, a second booking by the SAME user would be refused
// by that user's own calendar (409) before the room was ever looked at.
//
// Direct requests carry no X-Upstream (only the proxy adds it), so the run
// proves two copies answered in three other ways: it counts the distinct
// addresses that answered (res.remote_ip, the same address the proxy would
// have named), it reads copy B's availability right after copy A confirms,
// and it prints each copy's /health booking count before and after.
//
// Everything it books it cancels at the end, so it can be run again.
//
//   docker compose run --rm --no-deps \
//     -e A_URL=http://f26-lab09-api-1:8080 -e A_TOKEN=<api-1's u-1 token> \
//     -e B_URL=http://f26-lab09-api-2:8080 -e B_TOKEN=<api-2's u-2 token> \
//     k6 run /load/bookings.js
//
// Control run against one copy (the claim should hold there): B_URL set to
// A_URL, B_TOKEN set to that copy's u-2 token, and -e EXPECT_COPIES=1.

import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Gauge } from 'k6/metrics';

const A = { name: 'copy A', url: __ENV.A_URL, token: __ENV.A_TOKEN };
const B = { name: 'copy B', url: __ENV.B_URL, token: __ENV.B_TOKEN };
const ROOM = __ENV.ROOM || 'r-1';
const SLOTS = Number(__ENV.SLOTS || 3);
const DAYS_AHEAD = Number(__ENV.DAYS_AHEAD || 7);
const EXPECT_COPIES = Number(__ENV.EXPECT_COPIES || 2);

// The claim itself: slots that ended up confirmed for two users.
const slotDoubleBooked = new Counter('slot_double_booked');
// Whether the run could see the problem: how many copies answered.
const distinctCopies = new Gauge('distinct_copies');

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    slot_double_booked: ['count==0'],
    distinct_copies: [`value>=${EXPECT_COPIES}`],
  },
};

const answeredFrom = new Set();

export function setup() {
  for (const copy of [A, B]) {
    if (!copy.url || !copy.token) {
      throw new Error('Pass A_URL, A_TOKEN, B_URL and B_TOKEN (names from `docker compose ps`, '
        + 'tokens from `docker compose logs api`).');
    }
  }
  if (SLOTS < 1 || SLOTS > 5) {
    throw new Error('SLOTS must be 1 to 5: each user may hold at most 5 active bookings.');
  }
}

export default function () {
  const before = { a: bookingCount(A), b: bookingCount(B) };
  const made = [];

  for (let i = 0; i < SLOTS; i++) {
    const slot = slotAt(i);

    const resA = book(A, slot);
    if (resA.status !== 201) {
      cleanUp(made);
      exec.test.abort(`${A.name} did not confirm ${slot.start} (${describe(resA)}). `
        + 'The slot is not fresh: recreate the stack or pass a different DAYS_AHEAD.');
    }
    made.push({ copy: A, kind: 'bookings', id: resA.json('booking.id') });

    // What copy B says about the slot now that copy A has confirmed it.
    const bSeesItFree = isFree(B, slot);
    check(null, { 'copy B sees the slot taken once copy A has booked it': () => !bSeesItFree });

    const resB = book(B, slot);
    if (resB.status === 201) {
      made.push({ copy: B, kind: 'bookings', id: resB.json('booking.id') });
    } else if (resB.status === 202) {
      made.push({ copy: B, kind: 'waitlist', id: resB.json('waitlistEntry.id') });
    }
    const bothConfirmed = resB.status === 201;
    slotDoubleBooked.add(bothConfirmed ? 1 : 0, { slot: slot.start });
    check(resB, { 'second request for the slot is not confirmed': () => !bothConfirmed });

    console.log(`${ROOM} ${slot.start}: ${A.name} ${describe(resA)}; `
      + `${B.name} then saw it ${bSeesItFree ? 'FREE' : 'taken'}; ${B.name} ${describe(resB)}`);
  }

  const after = { a: bookingCount(A), b: bookingCount(B) };
  console.log(`/health bookings, before -> after: ${A.name} (${A.url}) ${before.a} -> ${after.a}; `
    + `${B.name} (${B.url}) ${before.b} -> ${after.b}`);
  console.log(`answered from ${answeredFrom.size} address(es): ${[...answeredFrom].join(', ')}`);

  cleanUp(made);
}

/** The i-th slot: an hour in ROOM, two hours apart, DAYS_AHEAD days from today (UTC). */
function slotAt(i) {
  const day = new Date(Date.now() + DAYS_AHEAD * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const hour = String(9 + 2 * i).padStart(2, '0');
  const endHour = String(10 + 2 * i).padStart(2, '0');
  return { date: day, start: `${day}T${hour}:00:00Z`, end: `${day}T${endHour}:00:00Z` };
}

function book(copy, slot) {
  return send(copy, 'POST', '/bookings', { roomId: ROOM, start: slot.start, minutes: '60' });
}

function isFree(copy, slot) {
  const res = send(copy, 'GET', `/rooms/${ROOM}/availability?date=${slot.date}`);
  const free = res.json('free') || [];
  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  return free.some((gap) => Date.parse(gap.start) <= start && end <= Date.parse(gap.end));
}

function bookingCount(copy) {
  return send(copy, 'GET', '/health').json('bookings');
}

/** Gives back what the run made, newest first, so a waiting entry goes before the booking ahead of it. */
function cleanUp(made) {
  for (const thing of made.slice().reverse()) {
    const res = send(thing.copy, 'DELETE', `/${thing.kind}/${thing.id}`);
    if (res.status !== 200 && res.status !== 204) {
      console.warn(`cleanup: DELETE /${thing.kind}/${thing.id} on ${thing.copy.name} -> ${describe(res)}`);
    }
  }
}

function send(copy, method, path, form) {
  const res = http.request(method, `${copy.url}${path}`, form || null, {
    headers: { Authorization: `Bearer ${copy.token}` },
  });
  if (res.remote_ip) {
    answeredFrom.add(`${res.remote_ip}:${res.remote_port}`);
    distinctCopies.add(answeredFrom.size);
  }
  return res;
}

function describe(res) {
  if (res.status === 201) {
    return `201 confirmed ${res.json('booking.id').slice(0, 11)}`;
  }
  if (res.status === 202) {
    return `202 waitlisted, position ${res.json('position')}`;
  }
  let code = '';
  try {
    code = res.json('error');
  } catch (notJson) {
    code = res.error || '';
  }
  return `${res.status} ${code}`;
}
