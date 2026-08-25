#!/usr/bin/env bash
# DEMO-001. `changeover demo` completes on a clean clone with no credentials and
# no network beyond the registry, in under 300 seconds, printing seven reels and
# refusing exactly four times with exactly the four expected codes.
#
# The cheaper check — grep the printed transcript for four code names — would
# pass against a demo that printed them from a string table with no Server
# running at all. So the four refusals are asserted on the OBJECTS the run
# returned: `--json` emits the result, and the assertions below read `codes`,
# `status` and `detail` out of it and compare them to `EXPECTED_REFUSALS` and
# `REFUSAL_STATUS`, both imported from the source rather than restated here.
#
# "No network" is likewise measured rather than claimed: the third run records
# every host `net.Socket.prototype.connect` and `dns.lookup` are called with and
# asserts the set is loopback and nothing else.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

# --- preconditions. Each one exits 2 and says how to satisfy it. -------------
[ -d node_modules/@electric-sql/pglite ] || { echo "cannot prove — PGlite not installed; run npm install at the repository root"; exit 2; }
[ -f packages/cli/src/commands/demo.ts ] || { echo "cannot prove — packages/cli/src/commands/demo.ts is missing"; exit 2; }
[ -f packages/cli/src/demo/run.ts ]      || { echo "cannot prove — packages/cli/src/demo/run.ts is missing"; exit 2; }
[ -f packages/store/src/fixtures.ts ]    || { echo "cannot prove — packages/store/src/fixtures.ts is missing"; exit 2; }
command -v node >/dev/null 2>&1          || { echo "cannot prove — node is not on PATH"; exit 2; }

# The published entrypoint where one exists, so this same script exercises
# `npx changeover demo` the moment `node_modules/.bin/changeover` is linked.
CLI="${CHANGEOVER_CLI:-node packages/cli/src/bin.ts}"

BUDGET_S=300
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail=0
pass=0
ok()  { echo "ok — $1"; pass=$((pass + 1)); }
bad() { echo "FAIL — $1"; fail=1; }

# --- 1 · the cold start, with the environment stripped to PATH ---------------
#
# `env -i` is the whole "no credentials" assertion: nothing this process can
# read names a database, a token, a key or a home directory. A demo that needed
# one would fail here rather than on somebody else's laptop.
echo "· running: env -i PATH=… ${CLI} demo --json"
start=$(date +%s)
env -i PATH="$PATH" $CLI demo --json > "$WORK/result.json" 2> "$WORK/result.err"
demo_status=$?
elapsed=$(( $(date +%s) - start ))

if [ "$demo_status" -eq 0 ]; then
  ok "the demo exited 0 with no environment but PATH — no credentials, no CHANGEOVER_PG_URL, no HOME"
else
  bad "the demo exited ${demo_status} with a stripped environment; stderr follows"
  sed -n '1,25p' "$WORK/result.err"
fi

if [ "$elapsed" -lt "$BUDGET_S" ]; then
  ok "it completed in ${elapsed}s, inside the ${BUDGET_S}s budget"
else
  bad "it took ${elapsed}s, at or over the ${BUDGET_S}s budget"
fi

[ -s "$WORK/result.json" ] || { echo "cannot prove — the demo emitted no JSON to assert against"; exit 2; }

# --- 2 · the assertions, on the returned objects ----------------------------
RESULT="$WORK/result.json" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { REFUSAL_STATUS, isRefusalCode } from "./packages/schema/src/refusal.ts";
import { EXPECTED_REFUSALS, REEL_IDS } from "./packages/cli/src/demo/reels.ts";

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const result = JSON.parse(readFileSync(process.env.RESULT, "utf8"));

// Seven reels, as objects with ids, not as seven printed headings.
const ids = result.reels.map((r) => r.id);
result.reels.length === 7
  ? ok("the run returned seven reels")
  : bad(`the run returned ${result.reels.length} reels`);
JSON.stringify(ids) === JSON.stringify([...REEL_IDS])
  ? ok(`the seven ran in order: ${ids.join(", ")}`)
  : bad(`the reels ran as ${ids.join(", ")}, not as ${REEL_IDS.join(", ")}`);

// EXACTLY four typed refusals, asserted against the expected list.
result.refusals.length === 4
  ? ok("exactly four typed refusals")
  : bad(`${result.refusals.length} typed refusals, not four`);
JSON.stringify(result.codes) === JSON.stringify([...EXPECTED_REFUSALS])
  ? ok(`their codes are exactly ${EXPECTED_REFUSALS.join(", ")}, in that order`)
  : bad(`their codes are ${result.codes.join(", ") || "(none)"}, not ${EXPECTED_REFUSALS.join(", ")}`);

// Each one a member of the closed taxonomy whose status the binding agreed with.
const wrong = result.refusals.filter((r) => !isRefusalCode(r.code) || r.status !== REFUSAL_STATUS[r.code]);
wrong.length === 0
  ? ok("every refusal is a member of the closed thirty-two, at the status §6.3 fixes for it")
  : bad(`${wrong.length} refusals disagree with REFUSAL_STATUS: ${wrong.map((r) => `${r.code}=${r.status}`).join(", ")}`);

// The three reels that must SUCCEED, so "four failed" cannot be satisfied by
// everything failing.
const succeeded = result.reels.filter((r) => r.refusal === null).map((r) => r.id);
JSON.stringify(succeeded) === JSON.stringify(["resolve", "hold", "hand_off"])
  ? ok("resolve, hold and hand_off succeeded — the four failures are chosen, not universal")
  : bad(`the reels that succeeded were ${succeeded.join(", ") || "(none)"}`);

// The detail branches, because a code with no detail is a refusal an Agent
// cannot act on beyond retrying.
const subst = result.refusals.find((r) => r.code === "substitution_refused");
subst?.detail?.crossed_axis === "presentation_class" && typeof subst?.detail?.from_occasion_id === "string"
  ? ok(`substitution_refused named ${subst.detail.from_occasion_id} across ${subst.detail.crossed_axis}`)
  : bad("substitution_refused carried no from_occasion_id / crossed_axis");

const fanout = result.refusals.find((r) => r.code === "cluster_fanout");
fanout?.detail?.limit === 1 && typeof fanout?.detail?.conflicting_hold_id === "string"
  ? ok(`cluster_fanout named the conflicting hold and the limit (${fanout.detail.cluster})`)
  : bad("cluster_fanout carried no conflicting_hold_id / limit");

const expired = result.refusals.find((r) => r.code === "hold_expired");
typeof expired?.detail?.expired_at === "string" && typeof expired?.detail?.occasion_id === "string"
  ? ok("hold_expired named when it expired and what it was for")
  : bad("hold_expired carried no expired_at / occasion_id");

// §7: a floor nobody measured is a constant.
result.floor.observations > 0 && result.floor.violations === 0 &&
  result.floor.circuit_policy_max_floor_ms <= result.floor.min_observed_retention_ms - result.floor.safety_margin_ms
  ? ok(`the published floor ${result.floor.circuit_policy_max_floor_ms}ms is warranted by ${result.floor.observations} observations, 0 violations`)
  : bad("the published floor is not warranted by the measurement in the same run");

// The demo agreed with itself about whether it held.
result.verdict.held === true
  ? ok("the demo agreed, on the same object asserted above, that its own gate held")
  : bad("the demo reported that its gate did not hold: " +
      result.verdict.checks.filter((c) => !c.ok).map((c) => c.text).join("; "));

console.log(`SUBPASS=${fail ? 0 : pass}`);
process.exit(fail);
' > "$WORK/assert.out" 2>&1
assert_status=$?
grep -E '^(ok|FAIL) — ' "$WORK/assert.out"
if [ "$assert_status" -ne 0 ]; then
  fail=1
  sed -n '1,25p' "$WORK/assert.out" | grep -v -E '^(ok|FAIL) — ' | head -12
fi
sub=$(sed -n 's/^SUBPASS=//p' "$WORK/assert.out")
[ -n "$sub" ] && pass=$((pass + sub))

# --- 3 · the printed transcript, which is a different claim -----------------
#
# Asserted separately and never instead: this is about the printer, and the
# refusals above are about the protocol. `--fast` because a shorter floor
# measurement does not change how many reels get printed.
env -i PATH="$PATH" $CLI demo --fast > "$WORK/transcript.txt" 2>&1
transcript_status=$?
reels_printed=$(grep -c '^REEL [1-7]/7 · ' "$WORK/transcript.txt")
if [ "$transcript_status" -eq 0 ] && [ "$reels_printed" -eq 7 ]; then
  ok "the human transcript printed seven reels and exited 0"
else
  bad "the human transcript printed ${reels_printed} reels and exited ${transcript_status}"
fi
if grep -q 'the gate holds\.' "$WORK/transcript.txt"; then
  ok "the transcript states its own verdict rather than leaving a reader to infer one"
else
  bad "the transcript never said whether the gate held"
fi

# --- 4 · no network beyond loopback, and the same shape twice ---------------
RESULT="$WORK/result.json" node --input-type=module -e '
import net from "node:net";
import dns from "node:dns";

const hosts = new Set();
const record = (h) => { if (typeof h === "string" && h.length > 0) hosts.add(h); };

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = args[0];
  if (typeof first === "object" && first !== null) record(first.host ?? first.path);
  else if (typeof args[1] === "string") record(args[1]);
  return connect.apply(this, args);
};
for (const key of ["lookup"]) {
  const original = dns[key];
  dns[key] = function (hostname, ...rest) { record(hostname); return original.call(dns, hostname, ...rest); };
  const promised = dns.promises[key];
  dns.promises[key] = function (hostname, ...rest) { record(hostname); return promised.call(dns.promises, hostname, ...rest); };
}

import { readFileSync } from "node:fs";
const { runDemo } = await import("./packages/cli/src/demo/run.ts");
const result = await runDemo({ floor_trials: 1, probe_floor_ms: 5000 });
const first = JSON.parse(readFileSync(process.env.RESULT, "utf8"));

let fail = 0, pass = 0;
const ok  = (m) => { console.log("ok — " + m); pass++; };
const bad = (m) => { console.log("FAIL — " + m); fail = 1; };

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const offsite = [...hosts].filter((h) => !LOOPBACK.has(h));
offsite.length === 0
  ? ok(`every socket and every lookup stayed on loopback (${[...hosts].join(", ") || "none opened"})`)
  : bad(`the run reached beyond loopback: ${offsite.join(", ")}`);

// And it is still the same run, at a different floor: the shape does not depend
// on how long the measurement took.
result.refusals.length === 4
  ? ok("a second run, at a different measured floor, still refused exactly four times")
  : bad(`the second run refused ${result.refusals.length} times`);

// The determinism claim, in the only form it can honestly take. The transcript
// itself carries real elapsed times, a CSPRNG hold id and a random
// `intent_digest`, so two runs CANNOT be byte-identical and a demo whose bytes
// repeated would be one that had stopped measuring. What must repeat is the
// shape, and `fingerprint` is exactly the shape with the unrepeatable parts left
// out — reel ids, outcomes, codes, statuses, remediations, in order.
result.fingerprint === first.fingerprint
  ? ok("two independent runs produced a byte-identical fingerprint")
  : bad(`the shape moved between runs:\n    ${first.fingerprint}\n    ${result.fingerprint}`);

// And the parts that must NOT repeat, did not.
first.reels[1].beats.some((b) => (b.block ?? []).some((l) => l.startsWith("hold_id")))
  ? ok("the transcript carries a per-run hold id, so the fingerprint is a projection and not the whole of it")
  : bad("the transcript printed no hold id, so the fingerprint claim asserts nothing");

console.log(`SUBPASS=${fail ? 0 : pass}`);
process.exit(fail);
' > "$WORK/net.out" 2>&1
net_status=$?
grep -E '^(ok|FAIL) — ' "$WORK/net.out"
if [ "$net_status" -ne 0 ]; then
  fail=1
  grep -v -E '^(ok|FAIL) — ' "$WORK/net.out" | head -12
fi
sub=$(sed -n 's/^SUBPASS=//p' "$WORK/net.out")
[ -n "$sub" ] && pass=$((pass + sub))

echo "PASS=$([ "$fail" -eq 0 ] && echo "$pass" || echo 0)"
exit "$fail"
