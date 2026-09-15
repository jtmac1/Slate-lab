// Engine worker: keeps field generation and simulation off the UI thread.
import { buildModel } from "../engine/model.mjs";
import { genField } from "../engine/field.mjs";
import { simulate, playerROI, stackROI } from "../engine/sim.mjs";
import { mulberry32 } from "../engine/rng.mjs";
import { structureReport, storyText } from "../engine/showdown.mjs";
import { lineupCoherence } from "../engine/model.mjs";

self.onmessage = e => {
  const m = e.data, id = m.id;
  try {
    if (m.type === "genField") {
      const g = genField(m.pool, m.n, m.opt, mulberry32(m.seed >>> 0), line => self.postMessage({ type: "log", id, line }));
      self.postMessage({ type: "done", id, result: { field: g.field, expo: Array.from(g.expo), cC: Array.from(g.cC), cF: Array.from(g.cF), log: g.log } });
    } else if (m.type === "simulate") {
      const model = buildModel(m.pool, m.modelOpts || {});
      const story = !!m.story && !m.fieldMode;
      const res = simulate({ pool: m.pool, model, field: m.field, lineups: m.lineups, payouts: m.payouts, entries: m.entries, fee: m.fee, story,
        iters: m.iters, maxIters: m.maxIters, rng: mulberry32(m.seed >>> 0), fieldMode: m.fieldMode, onProgress: (d, t) => self.postMessage({ type: "progress", id, done: d, total: t }) });
      res.players = playerROI(res, m.pool.players, m.pool.format);
      res.stacks = m.pool.format.sport === "mlb" ? stackROI(res, m.pool.players) : [];
      if (story) for (const r of res.rows) { r.coh = lineupCoherence(model, m.pool, r.lu, m.pool.format.mult); r.tale = storyText(m.pool, r); delete r.story; }
      self.postMessage({ type: "done", id, result: res });
    } else if (m.type === "sdStructures") {
      self.postMessage({ type: "done", id, result: { rows: structureReport(m.pool, m.field || [], { perStructure: m.per || 40, minFrac: m.minFrac || 0.9 }) } });
    }
  } catch (err) {
    self.postMessage({ type: "error", id, message: String(err && err.stack || err) });
  }
};
