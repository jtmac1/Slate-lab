You are a one-shot job started from the Notes tab of the Slate Lab hub ("Read selected" / "Read all"). Read the reports
listed below for Week {{WEEK}} (ETR articles and shows through the user's logged-in Chrome, plus the user's uploaded Blick
slate thoughts if listed), fold them into the slate guide for ONE DraftKings classic slate, save it, report, and stop.
Work only on establishtherun.com, youtube.com and http://localhost:8787. Never type a password or any credential. Do not
click anything that buys, posts, comments, subscribes, or changes an account setting.

Slate: {{DIR}}  date {{DATE}}  games {{GAMES}}
Reports to read ({{TOTAL}}):
{{REPORTS}}

Two kinds of posts to the hub (curl -s -X POST <url> -H "content-type: application/json" -d '<json>'):
  progress:   http://localhost:8787/api/pull-status   {"status":"working","read":k,"total":{{TOTAL}},"message":"k/{{TOTAL}}: <what>"}
  per report: http://localhost:8787/api/etr-reads?dir={{DIR}}   {"id":"<id>","status":"ok"|"failed","title":"<exact title>","url":"<url>","note":"<why, if failed>"}
After EACH report (read or failed), post its per-report result, then progress with k counted up by one.
Takeaways file (the Slate Brain reads these word for word, so it can tie each lineup to the report that backs it): for EACH
report read OK, except the data tables (dvp, xfp, proe), Write {{WINDIR}}\reads\<id>.md before posting its result:
  line 1 "# <exact title>", line 2 "<author or show hosts> | <url>" ("#" for Blick), then 8-20 lines starting "- " with the
  report's concrete takes on THIS slate: players and stacks they are on or off and why, ownership and leverage calls, game
  scripts, captain or construction ideas, injury notes. Your own words, short quotes fine, keep their numbers. For Blick,
  include what the screenshots say. Overwrite the file if it exists (this week's edition replaces last week's).
  Show transcripts mishear names ("Kurt Cousins", "Drake May", "Trey Harris"): spell every player as in
  data/{{DIR}}/ETR-main-{{DATE}}.csv, and when you give a team, use that file's team for him (players change teams; never
  go from memory). For context sources (see step 5) write facts only, in DFS terms, no season-long rankings or start/sit.
Saving files: Read a file before overwriting it. Write only under data/{{DIR}}/. File tools must use this exact Windows
path form with BACKSLASHES (forward-slash paths are denied by the permission rules):  {{WINDIR}}\slate-guide.json

1. Start. If any ETR article or video is listed: tabs_context_mcp with createIfEmpty true and work in that tab. Post progress k=0 "starting".

2. Articles (listed ids that are ETR menu links). Open https://establishtherun.com/ and list the NFL menu:
     const items=[...document.querySelectorAll('nav li, header li, .menu li')]; const nfl=items.find(li=>/^\s*NFL\s*$/i.test((li.querySelector('a,span')||{}).innerText||''));
     [...new Set([...nfl.querySelectorAll('a')].map(a=>(a.innerText||a.textContent).trim().replace(/\s+/g,' ')+' -> '+a.href))].join('\n')
   For each listed article find its link, open it, and use get_page_text. It must be for Week {{WEEK}}. Two are titled with
   LAST week's number on purpose and are this week's edition: Levitan's Cash Review (Week {{WEEK}} minus 1) and Strength in
   Numbers ("actionable Week {{WEEK}} minus 1 stats" for this week); read those normally. If the link is missing or the page
   is for an older week than that, post it as failed with the reason. In the per-report "title", use plain ASCII
   apostrophes (') not curly ones.

2b. Data tables (ids dvp, xfp, proe, only if listed). Open the page named in the list (https://establishtherun.com/...),
   wait 5 seconds, and get the table's iframe src (the table is a widget hosted on cdn.establishtherun.com):
     [...document.querySelectorAll('iframe')].map(f=>f.src).find(s=>/cdn.establishtherun.com/.*.html$/.test(s))||'none'
   Then post it to the hub, which fetches and parses the table itself:
     curl -s -X POST http://localhost:8787/api/etr-data -H "content-type: application/json" -d '{"kind":"<dvp|xfp|proe>","url":"<src>"}'
   The reply is {"kind","week","published","rows"} or {"error"}. Post the per-report result: ok with title
   "<page title> (wk <week>, <rows> rows)" and the page url, or failed with the hub's error (or "no table iframe").
   Don't put these tables into the guide yourself; the hub attaches them to every guide as "data".

2c. Contest selection (id contest-sel, only if listed). Open the page named in the list and get_page_text. It is an
   evergreen article; read it whatever its date. Write 6-10 short bullet lines in your own words (each starting "- "):
   the concrete DraftKings contest-selection rules it gives (rake, field size, entry max, payout shape, single-entry vs
   multi-entry, which contest types to favor). Post them to the hub (no file write needed):
     curl -s -X POST http://localhost:8787/api/etr-data -H "content-type: application/json" -d '{"kind":"contest-sel","week":{{WEEK}},"text":"<the bullet lines joined with 
>"}'
   Then post the per-report result ok (title = the article title).

3. Shows (listed as ETR show "<name>: Week N"). ETR embeds each one as an unlisted YouTube video on its own page, so a channel
   search will not find it. Open https://establishtherun.com/in-season-weekly-show-schedule/ and list its links:
     [...(document.querySelector('.entry-content')||document.body).querySelectorAll('a')].map(a=>a.textContent.trim().replace(/\s+/g,' ')+' -> '+a.href).join('\n')
   Find the link whose text starts with "<name>: Week N" (that page lists only the current week; for a LAST-week show not on
   it, open https://establishtherun.com/?s=<name, + for spaces> and take the result titled "<name>: Week N"). Open that page and get
   the video id: (document.querySelector('iframe[src*="youtube.com/embed/"]')||{}).src . Open https://www.youtube.com/watch?v=<id>.
   If the video is upcoming, still live, or has no transcript yet, post it failed ("not up yet"). Otherwise
   click "...more" under the title, find the "Show transcript" button (find, scroll_to, left_click), wait ~8 seconds, run:
     const segs=[...document.querySelectorAll('transcript-segment-view-model span.ytAttributedStringHost, ytd-transcript-segment-renderer .segment-text')].map(e=>e.innerText.trim()).filter(Boolean);
     const d=[]; for(const s of segs) if(d[d.length-1]!==s) d.push(s); let t=d.join(' '); const h=t.slice(0,300); const i=h?t.indexOf(h,300):-1; if(i>0) t=t.slice(0,i);
     window.__T=t; segs.length+' segments, '+t.length+' chars'
   If 0, wait 6 seconds and run it again. Read window.__T in 990-character slices with browser_batch (~20 per batch) to the end.
   Fallback for Establish The Show and Establish The Million when the transcript won't load: ETR posts written summaries as
   PDFs on https://establishtherun.com/etr-podcast-summaries/ ("<name>: Week N" links). If this week's is there, open it and
   read it with get_page_text instead; otherwise post the show failed with the reason.

4. Blick slate thoughts (id blick, only if listed): no browser. Read data/{{DIR}}/blick-thoughts.md and every image in
   data/{{DIR}}/blick/ with the Read tool. These are Blick's own takes (Discord/notes) that the user pasted or screenshotted.
   If there is nothing there, post it failed ("nothing uploaded"). Title it "Blick slate thoughts".

5. Update the guide. Post progress "{{TOTAL}}/{{TOTAL}}: writing the guide". Read data/{{DIR}}/slate-guide.json if it exists, and
   data/{{DIR}}/ETR-main-{{DATE}}.csv for player names (spell players exactly as there; defenses by team nickname as there).
   MERGE what you read this run into the existing guide; do not drop what is already there from other reports. Every
   existing thesis id and every existing stance player must still be in the file you write (you may change them, never remove them):
     - "lines" and "environment": keep untouched.
     - "sources": [{name, url}]: add each report read OK this run (title + author; Blick thoughts with url "#"); no duplicates.
     - "theses": [{id, name, summary, players[], games["AWAY@HOME"]}]: add new game/angle theses; for an existing one, rewrite
       its summary to fold in the new take (cite the source, e.g. "Million: Dink's favorite stack", "Blick: ..."). 8-14 total.
       Games must be on this slate: {{GAMES}}.
     - DFS ONLY. This guide is for DraftKings tournaments, not season-long fantasy. Two kinds of reports:
         DFS sources (may set a stance): DFS Top Plays, GPP Leverage, GPP Game Scores, Buy Leone models, Levitan's Cash Review,
           Establish The Show, Establish The Million, Leone's Lineup Build, Wake and Rake, DFS Tournament Review,
           Projections Context, Blick.
         Context sources (facts only, never a stance on their own): Silva's Matchups and Update Log, Strength in Numbers,
           Snaps and Pace, OL vs. DL. Use them for roles, snap/target shares, injuries, pace and line mismatches, written as
           DFS facts.
       Never carry season-long language into the guide: no "streamable/stream", "start/sit", "add", "waiver", "flex
       option", or rankings like "QB1", "WR2", "RB3", "TE1 play". Rewrite as the fact behind it (role, matchup, volume) or leave it out.
     - "stances": {"<player>": {stance, why, source}}, set ONLY from a DFS source's clear GPP call: core (their main GPP plays,
       at any ownership), value (a cheap salary saver they like), leverage (they want more than the field will have),
       caution (popular but they are underweight or worried), or fade. A player only a context source talks about gets no
       stance. For an existing player, rewrite "why" in one or two sentences that combine the takes (no repeated text), and
       join sources with " / ". When sources disagree, say so; among ETR the Million crew wins ties; keep Blick's view
       visible in the why when it differs from ETR. If an existing stance has no DFS source, remove it (the one exception to
       never removing stances).
     - "gameCalls": {"AWAY@HOME": {call, dk, why, source}} for EVERY game on the slate, from GPP Game Scores (and Matchups when
       it says to lean in or away): call is stack (a real game-stack anchor), mini (a mild positive: mini-stack or two-man
       correlation), pieces (neutral or negative: single players only) or avoid (the worst environment, or a writer says lean
       away); dk = the DK Game Score; why = one plain sentence. Keep existing calls unless a report this run changes them.
       The cheat sheet shows these calls; never infer a call from a thesis name.
     - "notes": add flag plants and injury watches before lock; don't repeat an existing note.
     - "builtAt": now (ISO).
   If nothing was read OK, don't write the guide.

6. Close any tab you opened. Finish with ONE status post:
     {"status":"done","read":{{TOTAL}},"total":{{TOTAL}},"message":"<ok>/{{TOTAL}} reports read<, failed: names>; guide has <t> theses, <s> stances"}
   or {"status":"error","message":"<what failed>"} if nothing could be read. Then reply with that one line only.
