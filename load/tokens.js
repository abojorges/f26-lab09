// Claim: a token works on any request, whichever copy answers it.
//
// Sends one copy's token through the proxy again and again, and records which
// copy answered each request (the proxy's X-Upstream header) and whether the
// token was accepted. The run passes only if every request was accepted AND
// the requests reached as many copies as expected, so a run that only ever
// hit one copy fails instead of passing on a check that could not see the
// problem.
//
//   docker compose run --rm --no-deps -e TOKEN=<a copy's u-1 token> k6 run /load/tokens.js
//
// Control run against one copy (the claim should hold there):
//   docker compose up -d --scale api=1, wait, take that copy's token, then add
//   -e EXPECT_COPIES=1.

import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { Gauge, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://proxy';
const TOKEN = __ENV.TOKEN;
const REQUESTS = Number(__ENV.REQUESTS || 40);
const EXPECT_COPIES = Number(__ENV.EXPECT_COPIES || 2);

// The claim itself: the share of requests on which the token was accepted.
const tokenAccepted = new Rate('token_accepted');
// Whether the run could see the problem: how many copies answered.
const distinctUpstreams = new Gauge('distinct_upstreams');

export const options = {
  vus: 1,
  iterations: REQUESTS,
  thresholds: {
    token_accepted: ['rate==1'],
    distinct_upstreams: [`value>=${EXPECT_COPIES}`],
  },
};

// One VU runs every iteration, so this tally sees the whole run.
const byUpstream = new Map();

export function setup() {
  if (!TOKEN) {
    throw new Error('Pass a token from `docker compose logs api`: -e TOKEN=...');
  }
}

export default function () {
  const res = http.get(`${BASE_URL}/bookings`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const upstream = res.headers['X-Upstream'] || '(no X-Upstream)';
  const accepted = res.status === 200;

  tokenAccepted.add(accepted, { upstream });
  check(res, { 'token accepted (200)': (r) => r.status === 200 });

  const tally = byUpstream.get(upstream) || { accepted: 0, rejected: 0, rejection: '' };
  if (accepted) {
    tally.accepted += 1;
  } else {
    tally.rejected += 1;
    tally.rejection = `${res.status} ${errorCode(res)}`;
  }
  byUpstream.set(upstream, tally);
  distinctUpstreams.add(byUpstream.size);

  if (exec.scenario.iterationInTest === REQUESTS - 1) {
    console.log(`${REQUESTS} requests through ${BASE_URL}, by the copy that answered:`);
    for (const [name, t] of byUpstream) {
      const rejected = t.rejected ? `, ${t.rejected} rejected (${t.rejection})` : '';
      console.log(`  ${name}: ${t.accepted} accepted${rejected}`);
    }
  }
}

function errorCode(res) {
  try {
    return res.json('error');
  } catch (notJson) {
    return '';
  }
}
