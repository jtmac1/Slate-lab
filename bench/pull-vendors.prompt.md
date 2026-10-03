You are a one-shot job started by the Slate Lab hub's "Pull ETR + Blick" button. Pull the user's ETR and Blick
projections for ONE slate through his logged-in Chrome, save them into the slate folder, refresh the hub, report,
and stop. Work only on establishtherun.com, blickanalytics.com, discord.com (the Blick login consent screen only)
and http://localhost:8787. Never type a password or any credential anywhere. Do not click anything that buys,
posts, or changes an account setting.

Slate: {{DIR}}  type {{TYPE}}  date {{DATE}}  Stokastic slateId {{SLATEID}}  games {{GAMES}}
Report progress with:  curl -s -X POST http://localhost:8787/api/pull-status -H "content-type: application/json" -d '{"status":"working","message":"..."}'

Saving files: the Write tool refuses to replace a file you haven't read, so before writing any file under data/, Read it
first if it exists (a missing file is fine to write directly). Write only under data/{{DIR}}/.

1. Start: tabs_context_mcp with createIfEmpty true, then work in that tab. Post status working "pulling ETR".

2. ETR.
   {{ETR_STEPS}}

3. Blick. Post status working "pulling Blick".
   Open {{BLICK_URL}}. If the page says SUBSCRIBERS ONLY, open
   https://blickanalytics.com/api/auth/login?next={{BLICK_NEXT}} ; Discord shows an "Authorize" consent screen for
   Blick Analytics (scopes: username + server roles). Click Authorize. If Discord instead asks for a login or a
   password, STOP Blick and note "Blick needs you to sign in to Discord". Once the table shows, run:
     const R=[...document.querySelectorAll('table tr')].map(tr=>[...tr.children].map(td=>td.innerText.trim().replace(/\s+/g,' ')));
     const n=s=>String(s).replace(/[%+$,]/g,'').replace('−','-').trim();
     const H=R[0].map(h=>h.replace(/\s+/g,' '));
     const body=R.slice(1).filter(r=>r.length===H.length).map(r=>r.map((c,i)=>i<4?(c.includes(',')?'"'+c+'"':c):n(c)).join(','));
     window.__C=[H.join(',')].concat(body.filter(l=>{const f=l.split(',');const p=+f[H.findIndex(h=>/^PROJ$/i.test(h))];return p>=2;})).join('\n');
     'rows '+(window.__C.split('\n').length-1)+' chars '+window.__C.length+' | '+((document.body.innerText.match(/UPDATED[^\n]*/i)||[''])[0])
   Read window.__C in slices of 950 characters (window.__C.slice(0,950), slice(950,1900), ...) using browser_batch,
   join them exactly, and Write the file to data/{{DIR}}/{{BLICK_FILE}} .

4. Close the tab you opened. Refresh the hub:
     curl -s -X POST http://localhost:8787/api/refresh -H "content-type: application/json" -d '{"date":"{{DATE}}","slateId":"{{SLATEID}}"}'
   From its JSON, read steps[name=merge].info.sources and note the etr and blick row counts.

5. Finish with ONE status post: {"status":"done","message":"ETR <rows> (<ETR stamp>), Blick <rows> (<Blick UPDATED stamp>)"}
   or, if a source failed, {"status":"done","message":"ETR ..., Blick failed: <why>"}; if both failed use "error".
   Then reply with that same one line and nothing else.
