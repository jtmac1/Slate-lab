// Engine worker: keeps field generation and simulation off the UI thread.
import { buildModel } from "../engine/model.mjs";
import { genField } from "../engine/field.mjs";
import { simulate, playerROI, stackROI } from "../engine/sim.mjs";
import { mulberry32 } from "../engine/rng.mjs";

self.onmessage = e => {
  const m = e.data, id = m.id;
  try {
    if (m.type === "genField") {
      const g = genField(m.pool, m.n, m.opt, mulberry32(m.seed >>> 0), line => self.postMessage({ type: "log", id, line }));
      self.postMessage({ type: "done", id, result: { field: g.field, expo: Array.from(g.expo), cC: Array.from(g.cC), cF: Array.from(g.cF), log: g.log } });
    } else if (m.type === "simulate") {
      const model = buildModel(m.pool, m.modelOpts || {});
      const res = simulate({ pool: m.pool, model, field: m.field, lineups: m.lineups, payouts: m.payouts, entries: m.entries, fee: m.fee,
        iters: m.iters, rng: mulberry32(m.seed >>> 0), fieldMode: m.fieldMode, onProgress: (d, t) => self.postMessage({ type: "progress", id, done: d, total: t }) });
      res.players = playerROI(res, m.pool.players, m.pool.format);
      res.stacks = m.pool.format.sport === "mlb" ? stackROI(res, m.pool.players) : [];
      self.postMessage({ type: "done", id, result: res });
    }
  } catch (err) {
    self.postMessage({ type: "error", id, message: String(err && err.stack || err) });
  }
};
