// Slate Lab grabber: a bookmarklet that does the "Pull ETR + Blick" and "Read ETR reports" jobs with no Claude. Click it on
// the page you want; it saves one file to Downloads, and the hub files it on Refresh (or when dropped on the hub).
// Pages: ETR DK projections (classic, showdown, early/afternoon), ETR data tables (DvP, XFP, PROE), any ETR article,
// a YouTube video with its transcript open, Blick ownership (GPP) and Blick conditional ownership.
// The page logic is the same JavaScript the Claude pull runs (bench/pull-vendors.prompt.md, server/hub.mjs startPull).
(async () => {
  const say = m => alert("Slate Lab: " + m), H = location.hostname, P = location.pathname;
  const save = (name, text) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };
  const q = v => { v = v == null ? "" : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const head = (kind, extra) => `#SLATELAB kind=${kind} url=${location.href}${extra ? " " + extra : ""}\n`;
  const gridRows = i => { const el = document.querySelectorAll(".ag-root-wrapper")[i]; if (!el) return null; const fk = Object.keys(el).find(k => k.startsWith("__reactFiber")); let f = el[fk]; while (f && !(f.memoizedProps && Array.isArray(f.memoizedProps.rowData))) f = f.return; return f ? f.memoizedProps.rowData : null; };
  const pick = (o, ...res) => { for (const re of res) { const k = Object.keys(o).find(k => re.test(k)); if (k != null) return o[k]; } return ""; };
  try {
    if (/establishtherun\.com$/.test(H)) {
      // showdown projections: player, pos, team, salary, proj, ceiling, total own, CPT own, CPT salary, CPT proj
      if (/showdown.*projections/.test(P) && document.querySelector(".ag-root-wrapper")) {
        const D = gridRows(0); if (!D) return say("no projections table found; wait for the page to load and click again");
        const rows = D.filter(o => +pick(o, /^proj/i) >= 0.5 || +pick(o, /own/i) > 0).map(o => [pick(o, /^player$/i, /name/i), pick(o, /^pos/i), pick(o, /^team$/i), pick(o, /^salary$/i, /flex.*sal/i), pick(o, /^proj/i), pick(o, /ceil/i), pick(o, /^(total|flex|large)?own/i, /own/i), pick(o, /c(a)?pt.*own/i), pick(o, /c(a)?pt.*sal/i), pick(o, /c(a)?pt.*proj/i)].map(q).join(","));
        save(`ETR-showdown-grab-${stamp()}.csv`, ["Player,Pos,Team,Salary,Proj,Ceiling,Total Own,CPT Own,CPT Salary,CPT Proj", ...rows].join("\n"));
        return say(`saved ETR showdown projections (${rows.length} players). Refresh the hub to file them.`);
      }
      // classic projections (main page, or the Early/Afternoon page: asks which table)
      if (/projections/.test(P) && document.querySelector(".ag-root-wrapper")) {
        let i = 0; if (/early-only|afternoon/.test(P)) i = confirm("OK = Early slate table, Cancel = Afternoon (late) table") ? 0 : 1;
        const D = gridRows(i); if (!D) return say("no projections table found; wait for the page to load and click again");
        const R = D.filter(o => o.projection >= 2 || o.largeOwnership > 0);
        save(`ETR-classic-grab-${stamp()}.csv`, ["player,team,opponent,position,salary,projection,floor,ceiling,largeOwnership,smallOwnership", ...R.map(o => [o.player, o.team, o.opponent, o.position, o.salary, o.projection, o.floor, o.ceiling, o.largeOwnership ?? o.ownership, o.smallOwnership ?? o.ownership].map(q).join(","))].join("\n"));
        return say(`saved ETR projections (${R.length} players). Refresh the hub to file them.`);
      }
      // data tables: the hub fetches the widget itself from its cdn address
      const kind = /dvp/.test(P) ? "dvp" : /expected-vs-actual/.test(P) ? "xfp" : /pass-rate-over/.test(P) ? "proe" : null;
      if (kind) { const src = [...document.querySelectorAll("iframe")].map(f => f.src).find(s => /cdn\.establishtherun\.com\/.*\.html$/.test(s)); if (!src) return say("table not loaded yet; wait a few seconds and click again");
        save(`slatelab-etr-${kind}-${stamp()}.txt`, head("etr-table", `table=${kind}`) + src + "\n"); return say(`saved the ${kind.toUpperCase()} table link. Refresh the hub to load it.`); }
      // any article: title + text, saved word for word for the Brain and for you
      const title = (document.querySelector("h1") || {}).innerText || document.title, body = document.querySelector("article, .entry-content, main") || document.body;
      const text = body.innerText.replace(/\n{3,}/g, "\n\n").trim(); if (text.length < 500) return say("this page has too little text to save");
      save(`slatelab-etr-article-${stamp()}.txt`, head("article", "source=ETR") + "TITLE " + title.trim().replace(/\s+/g, " ") + "\n\n" + text + "\n");
      return say(`saved "${title.trim().slice(0, 60)}" (${Math.round(text.length / 1000)}K characters). Refresh the hub to file it.`);
    }
    if (/youtube\.com$/.test(H)) {
      const segs = [...document.querySelectorAll("transcript-segment-view-model span.ytAttributedStringHost, ytd-transcript-segment-renderer .segment-text")].map(e => e.innerText.trim()).filter(Boolean);
      if (!segs.length) return say('open the transcript first: "...more" under the video, then "Show transcript", then click me again');
      const d = []; for (const s of segs) if (d[d.length - 1] !== s) d.push(s);
      const title = (document.querySelector("h1 yt-formatted-string, h1") || {}).innerText || document.title;
      save(`slatelab-show-${stamp()}.txt`, head("article", "source=YouTube") + "TITLE " + title.trim().replace(/\s+/g, " ") + "\n\n" + d.join(" ") + "\n");
      return say(`saved the transcript of "${title.trim().slice(0, 60)}". Refresh the hub to file it.`);
    }
    if (/blickanalytics\.com$/.test(H)) {
      if (/conditional-ownership/.test(P)) {
        const U = performance.getEntriesByType("resource").map(e => e.name).filter(n => /conditional-own-nfl/.test(n)); if (!U.length) return say("conditional data not loaded yet; wait a few seconds and click again");
        const S = JSON.parse(await (await fetch(U.find(n => !/contest/.test(n)) || U[0])).text()), sd = /showdown/.test(P);
        const pickC = sd ? S.contests.slice().sort((a, b) => (b.fee || 0) - (a.fee || 0))[0] : (S.contests.find(c => c.own_profile === "pOwn HS") || S.contests[0]), KEY = pickC.key;
        const u = new URL(U[U.length - 1]); u.searchParams.set("contest", KEY); const C = JSON.parse(await (await fetch(u)).text());
        let B;
        if (!sd) {
          const Pl = S.players, k = C.k, n = C.n, W = C.w, tw = W.reduce((a, b) => a + b, 0), L = []; for (let i = 0; i < n; i++) L.push(new Set(C.rows.slice(i * k, i * k + k)));
          const own = new Array(Pl.length).fill(0); L.forEach((l, i) => l.forEach(p => own[p] += W[i])); const pct = x => +(100 * x / tw).toFixed(2);
          const game = p => [Pl[p].team, Pl[p].opp].sort().join("@"), sum = f => { let s = 0; L.forEach((l, i) => { if (f(l)) s += W[i]; }); return s; };
          const qbs = Pl.map((p, i) => i).filter(i => Pl[i].pos === "QB" && pct(own[i]) >= 1).sort((a, b) => own[b] - own[a]).slice(0, 16), lines = [], used = new Set();
          for (const qb of qbs) { used.add(qb); const mates = Pl.map((p, i) => i).filter(i => i !== qb && game(i) === game(qb) && Pl[i].pos !== "DST" && Pl[i].proj >= 4);
            const cat = mates.filter(m => Pl[m].team === Pl[qb].team && /WR|TE/.test(Pl[m].pos)).sort((a, b) => Pl[b].proj - Pl[a].proj).slice(0, 4);
            const opp = mates.filter(m => Pl[m].team !== Pl[qb].team).sort((a, b) => Pl[b].proj - Pl[a].proj).slice(0, 6); mates.forEach(m => used.add(m));
            const one = mates.map(m => m + ":" + pct(sum(l => l.has(qb) && l.has(m)))), two = []; for (let a = 0; a < cat.length; a++) for (let b = a + 1; b < cat.length; b++) two.push(cat[a] + "." + cat[b] + ":" + pct(sum(l => l.has(qb) && l.has(cat[a]) && l.has(cat[b]))));
            const tri = []; for (const c of cat) for (const o of opp) tri.push(c + "." + o + ":" + pct(sum(l => l.has(qb) && l.has(c) && l.has(o))));
            lines.push("Q" + qb + "|" + pct(own[qb]) + "|" + one.join(",") + "|" + two.join(",") + "|" + tri.join(",")); }
          B = "EVENT " + S.event.replace(/[^\w ]/g, "") + " | BUILT " + C.built_at + " | CONTEST " + KEY + " | ENTRIES " + pickC.entries + " | N " + n + " | W " + tw.toFixed(1) + "\nP " + [...used].sort((a, b) => a - b).map(i => i + "~" + Pl[i].name + "~" + Pl[i].team + "~" + Pl[i].pos + "~" + pct(own[i])).join("^") + "\n" + lines.join("\n");
        } else {
          const Pl = S.players, k = C.k, n = C.n, W = C.w, tw = W.reduce((a, b) => a + b, 0), pct = x => +(100 * x / tw).toFixed(2), N = Pl.length / 2;
          const L = []; for (let i = 0; i < n; i++) { const l = C.rows.slice(i * k, i * k + k), c = l.find(p => Pl[p].slot === "CPT"); L.push({ cpt: Pl[c].pair, flex: l.filter(p => p !== c) }); }
          const cO = new Array(N).fill(0), fO = new Array(N).fill(0); L.forEach((l, i) => { cO[l.cpt] += W[i]; for (const p of l.flex) fO[p] += W[i]; });
          const side = {}; L.forEach((l, i) => { const c = {}; [l.cpt, ...l.flex].forEach(p => c[Pl[p].team] = (c[Pl[p].team] || 0) + 1); const [t, m] = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; const key = m === 3 ? "3-3" : m + "-" + (6 - m) + " " + t; side[key] = (side[key] || 0) + W[i]; });
          const caps = [...Array(N).keys()].filter(i => pct(cO[i]) >= 1).sort((a, b) => cO[b] - cO[a]);
          const lines = caps.map(c => { const pr = {}; L.forEach((l, i) => { if (l.cpt !== c) return; for (const p of l.flex) pr[p] = (pr[p] || 0) + W[i]; }); return "C" + c + "|" + pct(cO[c]) + "|" + Object.entries(pr).filter(([, v]) => pct(v) >= 0.05).map(([p, v]) => p + ":" + pct(v)).join(","); });
          const used = [...Array(N).keys()].filter(i => pct(fO[i]) >= 0.3 || pct(cO[i]) >= 0.3);
          B = "EVENT " + S.event.replace(/[^\w @]/g, "") + " | BUILT " + C.built_at + " | CONTEST " + KEY + " | ENTRIES " + pickC.entries + " | N " + n + " | W " + tw.toFixed(1) + "\nP " + used.map(i => i + "~" + Pl[i].name + "~" + Pl[i].team + "~" + Pl[i].pos + "~" + pct(fO[i]) + "~" + pct(cO[i])).join("^") + "\nS " + Object.entries(side).map(([a, v]) => a + ":" + pct(v)).join(",") + "\n" + lines.join("\n");
        }
        save(`slatelab-blick-conditional-${stamp()}.txt`, head("blick-cond") + B + "\n");
        return say(`saved Blick conditional ownership (${S.event}, contest ${pickC.label || KEY}). Refresh the hub to file it.`);
      }
      if (/ownership/.test(P)) {
        const R = [...document.querySelectorAll("table tr")].map(tr => [...tr.children].map(td => td.innerText.trim().replace(/\s+/g, " ")));
        if (R.length < 3) return say("no ownership table found; if it says SUBSCRIBERS ONLY, sign in first");
        const n = s => String(s).replace(/[%+$,]/g, "").replace("−", "-").trim(), Hd = R[0].map(h => h.replace(/\s+/g, " ")), pj = Hd.findIndex(h => /^PROJ$/i.test(h));
        const body = R.slice(1).filter(r => r.length === Hd.length).map(r => r.map((c, i) => i < 4 ? q(c) : n(c)).join(",")).filter(l => pj < 0 || +l.split(",")[pj] >= 2);
        const wk = (document.body.innerText.match(/week\s*(\d+)/i) || [])[1];
        // classic: the name the Claude pull uses (the hub reads the week from it); showdown: let the hub name it by its teams
        save(!/showdown/.test(P) && wk ? `nfl-main-${new Date().getFullYear()}wk${String(wk).padStart(2, "0")}.csv` : `blick-${/showdown/.test(P) ? "showdown" : "main"}-grab-${stamp()}.csv`, [Hd.join(","), ...body].join("\n"));
        return say(`saved Blick projections (${body.length} players). Refresh the hub to file them.`);
      }
    }
    say("open one of: ETR DK projections, an ETR article or data table, a YouTube show with its transcript open, or a Blick ownership / conditional ownership page");
  } catch (e) { say("something went wrong: " + e.message); }
})();
