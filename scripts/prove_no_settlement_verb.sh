#!/usr/bin/env bash
# C-ABSENCE.1. The absence being asserted is SETTLEMENT, not the word: `price`
# is deliberately omitted from the pattern, because price_disclosure,
# price_basis and price_band are legitimate read-side members, and a check that
# fails on them is a check somebody disables.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2
[ -f schemas/verbs.json ] || { echo "cannot prove — schemas/verbs.json missing"; exit 2; }
[ -f schemas/member-manifest.json ] || { echo "cannot prove — schemas/member-manifest.json missing"; exit 2; }
node -e '
const fs = require("fs");
const PATTERN = /settle|pay|capture|refund|charge/i;
const verbs = JSON.parse(fs.readFileSync("schemas/verbs.json", "utf8")).verbs;
const members = JSON.parse(fs.readFileSync("schemas/member-manifest.json", "utf8")).members;
let fail = 0, pass = 0;
if (verbs.length === 5) { console.log("ok — verbs.json declares exactly 5 verbs"); pass++; }
else { console.log(`FAIL — verbs.json declares ${verbs.length} verbs, expected 5`); fail = 1; }
const badVerbs = verbs.filter(v => PATTERN.test(v));
if (!badVerbs.length) { console.log("ok — 0 verbs match /settle|pay|capture|refund|charge/"); pass++; }
else { console.log(`FAIL — settlement verb present: ${badVerbs.join(", ")}`); fail = 1; }
const badMembers = members.filter(m => PATTERN.test(m));
if (!badMembers.length) { console.log(`ok — 0 of ${members.length} manifested members match the settlement pattern`); pass++; }
else { console.log(`FAIL — settlement member present: ${badMembers.join(", ")}`); fail = 1; }
console.log(`PASS=${fail ? 0 : pass}`);
process.exit(fail);
'
