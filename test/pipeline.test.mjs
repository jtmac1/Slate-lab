import test from "node:test";
import assert from "node:assert/strict";
import { ownTier } from "../server/contestsim.mjs";
import { ownOf } from "../server/foursim.mjs";

// The field's ownership follows the contest (user, 2026-10-10: "ensure all of this is working as intended"); the live-data
// version of these checks is bench/audit-pipeline.mjs.
test("ownership tier by contest", () => {
  assert.equal(ownTier(false, { fee: 4444, field: 634 }).src, "blickHS");     // $100+, 1,000 or fewer
  assert.equal(ownTier(false, { fee: 4444, field: 634 }).curve, false);
  assert.equal(ownTier(false, { fee: 100, field: 1000 }).src, "blickHS");     // edges are inclusive
  assert.equal(ownTier(false, { fee: 99, field: 600 }).src, "vavg");          // under $100 is not high stakes
  assert.equal(ownTier(false, { fee: 20, field: 161764 }).src, "vavg");       // large field
  assert.equal(ownTier(false, { fee: 20, field: 161764 }).curve, false);
  assert.equal(ownTier(false, { fee: 1500, field: 4444 }).curve, true);       // in between: model on Stokastic-only players
  assert.equal(ownTier(false, null).src, "vavg");                             // no contest picked
  assert.equal(ownTier(true, { fee: 333, field: 600 }).src, "avg");           // showdown: every vendor
});

test("ownership sources read the right numbers", () => {
  const vendors = ["stk", "etr", "blick"];
  const r = { stk: { own: 30 }, etr: { own: 20 }, blick: { own: 10, ownHS: 14, ownSE: 12 } };
  assert.equal(ownOf(r, "blickHS", vendors), 14);                            // Blick high-stakes first
  assert.equal(ownOf({ ...r, blick: { own: 10, ownSE: 12 } }, "blickHS", vendors), 12);   // then single-entry
  assert.equal(ownOf(r, "vavg", vendors), 15);                               // ETR + Blick, Stokastic left out
  assert.equal(ownOf({ stk: { own: 30 } }, "vavg", vendors), 30);            // only Stokastic: falls back to it
  assert.equal(ownOf(r, "avg", vendors), 20);                                // showdown: all three
});
