// MCP server e2e: an in-process server on an in-memory transport and a real (headless) Chromium, with
// no model anywhere: the test plays the client's model. Direct tools return evidence and keep secret
// values out of every result; a client that can ask its person (elicitation) confirms an irreversible
// click. And the real CLI, started over stdio with every API key unset, lists its tools and serves
// browser calls without a single model request.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { applyInOrder } from "@pilotfish/perception";
import type { McpConfig } from "./config.js";
import { createMcpServer, type PilotfishMcp } from "./server.js";

const E2E = process.env.PILOTFISH_E2E === "1";
const SECRET = "hunter2-xyz";

// A long results page: 60 cards, each a title link, a price and a button, about 140 px apart.
const RESULTS_HTML = `<!doctype html><html><head><title>Results</title><style>.card{height:120px;margin:10px;border:1px solid #ccc}</style></head><body><h1>Results</h1>${Array.from(
  { length: 60 },
  (_, i) => `<div class="card"><a href="#r${i + 1}">Result ${i + 1} title</a><p>Price $${(i + 1) * 3}.00</p><button>Add ${i + 1}</button></div>`,
).join("")}</body></html>`;

const HOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Console</title></head><body>
<h1>Console</h1>
<button id="go" onclick="document.getElementById('out').textContent='Launched the probe'">Launch</button>
<button id="del" onclick="document.getElementById('out').textContent='Draft deleted'">Delete draft</button>
<p id="out"></p>
<label for="tok">Access token</label><input id="tok" type="text">
<label for="size">Size</label><select id="size"><option>Small</option><option>Large</option></select>
<p><a href="/otp">Verify</a></p>
</body></html>`;

const OTP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Verify your identity</title></head>
<body><main style="width:420px;margin:60px auto">
<h1>Enter verification code</h1>
<p>Enter the 6-digit code we sent to <strong>•••1234</strong>. It expires in 10 minutes.</p>
<form onsubmit="event.preventDefault()"><div>
${[1, 2, 3, 4, 5, 6].map((i) => `<input type="text" inputmode="numeric" maxlength="1" aria-label="Digit ${i}" autocomplete="off" style="width:40px">`).join("\n")}
</div><button type="submit">Verify</button></form>
</main>
<script>
  document.addEventListener('input', () => {
    const v = [...document.querySelectorAll('input')].map((i) => i.value).join('');
    if (v.length === 6) { document.body.dataset.code = v; document.querySelector('main').innerHTML = '<h1>Account</h1><p>Welcome back, Ada.</p>'; }
  });
</script></body></html>`;

// Pages only a person can pass, and one nobody can.
const SIGNIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body><main style="width:380px;margin:60px auto">
<h1>Sign in to your account</h1><form onsubmit="event.preventDefault()"><label>Email <input type="email" name="email" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>
<p><a href="/forgot">Forgot your password?</a></p></main></body></html>`;
const ROBOT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Security check</title></head><body><h1>Are you a robot?</h1>
<p>Please complete the security check to continue.</p><div style="width:300px;height:80px;border:1px solid #999">I'm not a robot</div></body></html>`;
const BLOCKED_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Attention Required! | Cloudflare</title></head><body>
<h1>Sorry, you have been blocked</h1><p>You are unable to access this site.</p><p>Cloudflare Ray ID: 8f2a1b3c4d5e6f70</p></body></html>`;

// Results that are still loading: an interim price under the page's own progress bar, the final one 1.5 s later.
const LOADING_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Flights</title></head><body><h1>Flights</h1>
<div role="tablist"><div role="tab" aria-selected="true">Best</div><div role="tab" id="cheap">Cheapest from ₹10,041 <div role="progressbar" aria-label="Fetching results" style="width:80px;height:4px;background:#36c"></div></div></div>
<p role="meter" aria-valuenow="65">Rated 4.3</p><div role="progressbar" aria-valuenow="65" aria-label="5 star" style="width:80px;height:6px;background:#fa0"></div>
<script>setTimeout(() => { document.getElementById('cheap').textContent = 'Cheapest from ₹9,564'; }, 1500);</script></body></html>`;
const SPINNER_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Spinner</title></head><body><h1>Always busy</h1>
<div role="progressbar" style="width:40px;height:40px;background:#ccc"></div><button onclick="this.textContent='Pressed'">Press</button></body></html>`;

// A fares page (16 Nov, Google Flights): a "Loading results" spinner that never stops, and a search that shows a
// "Fetching results" bar for 1.5 s while the cheapest fare is still an early figure.
const FARES_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fares</title></head><body><h1>Fares</h1>
<div role="progressbar" aria-label="Loading results" style="width:28px;height:28px;background:#ccc"></div>
<button onclick="go()">Search</button><p id="cheap">No search yet</p><div id="bar"></div>
<button onclick="slow=true;go()">Slow search</button>
<a href="/fares" target="_blank">Open again</a>
<script>let slow=false, n=0; function go(){ n++; document.getElementById('cheap').textContent='Cheapest from ₹9,584 (search '+n+')'; document.getElementById('bar').innerHTML='<div role="progressbar" aria-valuenow="0" aria-label="Fetching results" style="width:80px;height:16px;background:#36c"></div>';
const ms = slow ? 7000 : 1500; slow=false;
setTimeout(()=>{ document.getElementById('cheap').textContent='Cheapest from ₹9,108 (search '+n+')'; document.getElementById('bar').innerHTML=''; }, ms); }</script></body></html>`;
// A suggestion list whose entries are a name over the place it belongs to (two of them share a name).
const SUGGEST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Where to</title></head><body><h1>Where to</h1>
<input role="combobox" aria-label="Destination" value="North Ridge"><ul role="listbox" aria-label="Suggestions">
<li role="option" aria-label="North Ridge Westland"><div><div>North Ridge</div><div>Westland</div></div></li>
<li role="option" aria-label="North ridge Lakes (North Ridge), Westland"><div><div>North ridge</div><div>Lakes (North Ridge), Westland</div></div></li>
<li role="option"><div><b>North</b> Ridge Inn</div></li></ul></body></html>`;
// A field that opens a list of suggestions when clicked, and fills its value from typing.
const WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Field</title></head><body><h1>Field</h1>
<input aria-label="When" id="when" onclick="document.getElementById('picker').hidden=false">
<ul id="picker" role="listbox" aria-label="Dates" hidden><li role="option">Today</li><li role="option">Tomorrow</li></ul>
<input type="date" aria-label="Day" onclick="document.getElementById('clicked').hidden=false"><p id="clicked" hidden>Day was clicked</p></body></html>`;
// Acting tools with snapshot:false (17 Nov): controls that add a button or flip a line, a field, an irreversible-looking
// button, a link to a page only a person can pass, and enough text that a small change is a change list.
const QUIET_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Filters</title></head><body><h1>Filters</h1>
<button onclick="addOne()">Add filter</button><button onclick="const s=document.getElementById('st'); s.textContent=s.textContent==='Off'?'On':'Off'">Toggle</button>
<button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true'); document.getElementById('tok').value='auto'; for (let k=0;k<12;k++) addOne()">Add many</button>
<p id="st">Off</p><label for="tok">Access token</label><input id="tok" type="text"><div id="added"></div>
<button>Delete draft</button><a href="/otp">Verify</a>
${Array.from({ length: 30 }, (_, i) => `<p>Note ${i + 1}: filters apply to every list on this page</p>`).join("")}
<script>let n=0; function addOne(){ n++; const b=document.createElement('button'); b.textContent='Remove filter '+n; document.getElementById('added').appendChild(b); }</script></body></html>`;
// A destination field (17 Nov): two suggestions with the same name in different places, a search that goes to a results
// page whose heading and breadcrumb (an ARIA breadcrumb) say which place it resolved, from the address.
const PICK_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Stays</title></head><body><h1>Find a stay</h1>
<input role="combobox" aria-label="Destination" id="dest" value="North Ridge"><ul role="listbox" aria-label="Suggested destinations">
<li role="option" tabindex="0" onclick="pick('North Ridge, Westland','region')">North Ridge Westland</li>
<li role="option" tabindex="0" onclick="pick('North ridge, Lakes (North Ridge), Westland','city')">North ridge Lakes (North Ridge), Westland</li>
<li role="option" tabindex="0" onclick="pick('North Ridge Inn','hotel')">North Ridge Inn</li></ul>
<button onclick="location.href='/stays?ss='+encodeURIComponent(document.getElementById('dest').value)+'&type='+document.getElementById('dest').dataset.type">Search</button>
<a href="/guide/north-ridge-and-the-lakes?utm_source=newsletter&utm_campaign=winter-2026-a-long-campaign-name&ref=abcdef0123456789">Destination guide</a>
<script>function pick(v,t){ const d=document.getElementById('dest'); d.value=v; d.dataset.type=t; }</script></body></html>`;
const staysHtml = (q: URLSearchParams) => {
  const city = q.get("type") === "city";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Stays</title></head><body>
<nav aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/w">Westland</a>${city ? ` › <a href="/l">Lakes</a> › <span>North ridge</span>` : ` › <span>North Ridge</span>`}</nav>
<h1>${city ? "North ridge: 8 stays found" : "North Ridge: 2,087 stays found"}</h1><p>Sorted by our top picks</p></body></html>`;
};
// A page that hides its background from assistive tech (aria-hidden) while its listbox is open, as Google Flights does,
// and a modal dialog (showModal: the background inert), with text enough that a listbox is a small part of it (17 Nov).
const ARIA_HIDDEN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Trips</title></head><body>
<header><nav aria-label="Main"><a href="/" aria-label="Home">Logo</a><button onclick="this.textContent='Signed out'">Sign in</button></nav></header>
<main id="bg"><h1>Find a trip</h1>
<div role="combobox" aria-haspopup="listbox" aria-expanded="false" tabindex="0" id="cb" aria-label="Ticket type. Round trip" onclick="openList()">Round trip</div>
<input aria-label="Where from?" value="Delhi"><button onclick="document.getElementById('dlg').showModal()">Offers</button>
${Array.from({ length: 24 }, (_, i) => `<p>Tip ${i + 1}: fares change often, so check again before you book</p>`).join("")}
</main>
<ul id="lb" role="listbox" aria-label="Ticket types" hidden><li role="option" tabindex="0">Round trip</li><li role="option" tabindex="0">One way</li></ul>
<dialog id="dlg"><p>Save 10% when you sign in</p><button onclick="this.closest('dialog').close()">Dismiss</button></dialog>
<script>function openList(){ document.getElementById('lb').hidden=false; document.getElementById('cb').setAttribute('aria-expanded','true');
  document.querySelector('header').setAttribute('aria-hidden','true'); document.getElementById('bg').setAttribute('aria-hidden','true'); }</script></body></html>`;
// browser_wait with snapshot:false (17 Nov): a total that comes 1.5 s after a click (with a new button), a flip, and
// buttons that move the page to another document or to a sign-in page after a moment; text enough for change lists.
const WAITQ_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Totals</title></head><body><h1>Totals</h1>
<p id="st">Ready</p><button onclick="go()">Load</button>
<button onclick="const f=document.getElementById('flag'); f.textContent=f.textContent==='Side A'?'Side B':'Side A'">Flip</button><p id="flag">Side A</p>
<button onclick="setTimeout(()=>{location.href='/quiet?moved'},800)">Move</button><button onclick="setTimeout(()=>{location.href='/signin'},800)">Sign in later</button>
${Array.from({ length: 30 }, (_, i) => `<p>Line ${i + 1}: totals include every item on this page</p>`).join("")}
<script>function go(){ const s=document.getElementById('st'); s.textContent='Totals pending'; setTimeout(()=>{ s.textContent='Total ₹4,321'; const b=document.createElement('button'); b.textContent='Details'; s.after(b); }, 1500); }</script></body></html>`;
// A results site (17 Nov) that applies only parameters it knows and says in its heading what it applied: the page, a
// sort and a price filter it offers through its own links and its own form, and a long tracking link whose query the
// screen elides. Its search box repeats the words as given, so "under 2000" typed into the query shows there while no
// filter is applied. A session value it did not issue gets its sign-in page, not results.
// Re-grounding (Stage A1): buttons drawn, then all re-created in another order after the first capture, so a held
// ref's node is gone and must be found again. Each button counts its own clicks by a key no name or ref carries.
const REGROUND_LAYOUTS: Record<string, [string[], string[]]> = {
  reorder: [["x:Xray", "a:Alpha", "b:Bravo"], ["b:Bravo", "a:Alpha", "x:Xray"]],
  remove: [["x:Xray", "a:Alpha", "b:Bravo"], ["b:Bravo", "x:Xray"]],
  same: [["a1:Alpha", "a2:Alpha", "b:Bravo"], ["b:Bravo", "a1:Alpha", "a2:Alpha"]],
  group: [["a1:Alpha", "a2:Alpha", "b:Bravo"], ["b:Bravo", "a1:Alpha", "a2:Alpha", "a3:Alpha"]],
};
const regroundHtml = (mode: string) => {
  const [first, then] = REGROUND_LAYOUTS[mode] ?? REGROUND_LAYOUTS["reorder"]!;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Reground</title></head><body><h1>Buttons</h1><div id="box"></div><p id="hits">{}</p>
<script>const hits = {};
const make = (s) => { const [k, n] = s.split(":"); const b = document.createElement("button"); b.textContent = n; b.onclick = () => { hits[k] = (hits[k] || 0) + 1; document.getElementById("hits").textContent = JSON.stringify(hits); }; return b; };
const draw = (list) => document.getElementById("box").replaceChildren(...list.map(make));
draw(${JSON.stringify(first)}); setTimeout(() => draw(${JSON.stringify(then)}), 1500);</script></body></html>`;
};
// Stage B (17 Nov): a batch whose step 2 raises a dialog, opens a tab or has a write refused; step 3 counts if run.
const batchHtml = (mode: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Batch</title></head><body><h1>Batch</h1>
<select aria-label="Size"><option>Small</option><option>Large</option></select>
<button onclick="mark('s2'); ${mode === "dialog" ? "alert('Saved draft')" : mode === "tab" ? "window.open('/spa')" : mode === "loading" ? "busy()" : "fetch('/fail', { method: 'POST', body: 'x' })"}">Two</button>
<button onclick="mark('s3')">Three</button><p id="hits">{}</p>
<script>function busy() { const d = document.createElement('div'); d.setAttribute('role', 'progressbar'); d.setAttribute('aria-busy', 'true'); d.setAttribute('aria-label', 'Loading results'); d.style.cssText = 'width:24px;height:24px;background:#ccc'; document.body.prepend(d); }
const hits = {}; function mark(k) { hits[k] = (hits[k] || 0) + 1; document.getElementById('hits').textContent = JSON.stringify(hits); }</script></body></html>`;
// Fields whose page changes, resets, limits, reformats or validates what is typed, and ones that must stay masked.
const FIELDS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fields</title></head><body><h1>Fields</h1><form onsubmit="return false">
<input aria-label="Plain">
<input type="password" aria-label="Password">
<input aria-label="Echo" oninput="this.setCustomValidity(this.value ? 'Not accepted: ' + this.value : '')">
<span id="slot"><input aria-label="Swapped" oninput="document.getElementById('slot').innerHTML = '<input aria-label=Swapped>'"></span>
<input aria-label="Reset" oninput="setTimeout(() => { this.value = '' }, 0)">
<input aria-label="Short" maxlength="3">
<input aria-label="Phone" oninput="const d = this.value.replace(/\\D/g, ''); this.value = d.length > 3 ? '(' + d.slice(0, 3) + ') ' + d.slice(3) : d">
<input type="email" required aria-label="Email">
<input aria-label="Code" oninput="this.setAttribute('aria-invalid', this.value.length < 4 ? 'true' : 'false')">
<select multiple aria-label="Extras"><option>Bag</option><option>Meal</option><option>Seat</option></select>
<div contenteditable="true" role="textbox" aria-label="Note"></div>
</form></body></html>`;
// Stage C (17 Nov): expectations. A button whose own label changes late, a list that gets two "Saved" lines, a
// scrollable box replaced whole, a same-origin frame with its own button, a link to another document, an alert.
const EXPECT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Expect</title></head><body><h1>Expect</h1>
<button onclick="setTimeout(() => { this.textContent = 'Added to cart' }, 400)">Add</button>
<button onclick="document.getElementById('note').textContent = 'Empty'">Noop</button><p id="note">Empty</p>
<button onclick="for (let i = 0; i < 2; i++) document.body.appendChild(Object.assign(document.createElement('p'), { textContent: 'Saved' }))">Dup</button>
<div id="wrap"><div id="box" style="height:40px;overflow:auto"><p>Line one</p><p>Line two</p><p>Line three</p><p>Line four</p></div></div>
<button onclick="document.getElementById('wrap').innerHTML = '<div style=height:40px;overflow:auto><p>New</p><p>Lines</p><p>Here</p><p>Now</p></div>'">Swap</button>
<button onclick="alert('Heads up')">Warn</button>
<button onclick="setTimeout(() => { document.querySelector('iframe').contentDocument.querySelector('button').textContent = 'Done here' }, 300)">Ping</button>
<a href="/spa">Go</a>
<iframe srcdoc="<button onclick=&quot;this.textContent='Done here'&quot;>Inner</button>" style="width:300px;height:60px"></iframe>
<iframe id="gone" srcdoc="<button onclick=&quot;parent.document.getElementById('gone').remove()&quot;>Vanish</button>" style="width:300px;height:60px"></iframe>
</body></html>`;
// Review fixtures (R1-R7, 17 Nov evening).
const R_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Review</title></head><body><h1>Review</h1>
<button onclick="void 0">Still</button>
<button onclick="fetch('/fail', { method: 'POST', body: 'x' })">Ping server</button>
<input type="password" aria-label="Pin" oninput="this.setCustomValidity('Wrong pin: ' + this.value); this.type = 'text'">
<button onclick="setTimeout(() => document.body.appendChild(Object.assign(document.createElement('p'), { textContent: 'Arrived late' })), 1200)">Late</button>
<div id="box" style="height:40px;overflow:auto"><p>One</p><p>Two</p><p>Three</p><p>Four</p></div>
<button onclick="const b = document.getElementById('box'); b.appendChild(Object.assign(document.createElement('p'), { textContent: 'Ready now' })); b.style.display = 'none'">Hide</button>
<button onclick="document.body.appendChild(Object.assign(document.createElement('p'), { textContent: 'Ghost text', style: 'display:none' }))">Ghost</button>
<button onclick="setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Show details'; b.onclick = () => { const h = document.getElementById('late-hits'); h.textContent = String(Number(h.textContent) + 1) }; document.body.prepend(b) }, 1200)">Late control</button>
<p id="late-hits">0</p>
</body></html>`;
const scopeHtml = (second: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>Scope</title></head><body><h1>Shop</h1>
<div style="height:40px;overflow:auto"><p>${second ? "Order placed" : "Waiting"}</p><p>a</p><p>b</p><p>c</p></div>
${second ? "" : '<a href="/scope2">Next</a>'}</body></html>`;
// Second review (A-C): password fields the page turns into text; events while an expectation is polled.
const SECRET_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Secret</title></head><body><h1>Secret</h1>
<input type="password" aria-label="Code" oninput="this.type = 'text'">
<input type="password" aria-label="Pin2" oninput="this.type = 'text'">
<input type="password" aria-label="Quote" oninput="this.type = 'text'">
<button onclick="document.getElementById('n').textContent = 'Next pressed ' + Date.now()">Next step</button><p id="n">-</p>
</body></html>`;
const LATE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Late</title></head><body><h1>Late</h1>
<button onclick="setTimeout(() => { alert('Late alert'); fetch('/fail', { method: 'POST', body: 'x' }); document.body.appendChild(Object.assign(document.createElement('p'), { textContent: 'Done later' })) }, 1200)">Late events</button>
<button onclick="setTimeout(() => { location.href = '/scope1' }, 1200)">Late go</button>
<button onclick="setTimeout(() => { busy(); document.body.appendChild(Object.assign(document.createElement('p'), { textContent: 'Busy shown' })) }, 1200)">Late busy</button>
<script>function busy() { const d = document.createElement('div'); d.setAttribute('role', 'progressbar'); d.setAttribute('aria-busy', 'true'); d.setAttribute('aria-label', 'Loading results'); d.style.cssText = 'width:24px;height:24px;background:#ccc'; document.body.prepend(d); }</script>
</body></html>`;
// Third review: a short password the page echoes, with a prefix, into its status line, heading, title, address
// query and validation message (the field turned into a text field as it is typed into).
const ECHO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Echo</title></head><body><h2>Hello</h2><p id="st">-</p>
<input type="password" aria-label="Pin" oninput="const v = this.value; this.type = 'text'; this.setCustomValidity('Bad pin: ' + v); document.getElementById('st').textContent = 'Pin set: ' + v; document.title = 'Pin ' + v; document.querySelector('h2').textContent = 'Hello ' + v; history.replaceState(null, '', '/echo?pin=' + encodeURIComponent(v))">
<button onclick="document.getElementById('st').dataset.n = String(Date.now())">Next step</button>
</body></html>`;
// Fourth review: a short password echoed glued to other characters (prefix + secret + suffix) everywhere the page
// can show it, and in base64.
const GLUE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Glue</title></head><body><h2>H</h2><p id="st">-</p><p id="b64">-</p>
<input type="password" aria-label="Pin" oninput="const v = this.value; this.type = 'text'; this.setCustomValidity('Bad' + v + '!'); document.getElementById('st').textContent = 'Pin' + v + 'ok'; document.getElementById('b64').textContent = 'B64:' + btoa(v) + 'end'; document.title = 'T' + v + 'x'; document.querySelector('h2').textContent = 'H' + v + 'Z'; history.replaceState(null, '', '/glue?p=a' + encodeURIComponent(v) + 'b')">
<button onclick="document.getElementById('st').dataset.n = String(Date.now())">Next step</button>
</body></html>`;
// Fifth review: a one-character password ("e") that collides with the ref grammar; a new button appears only after
// typing, and counts its clicks. A field the page reads back glued ("AqB") for a schema-constrained query.
const COLLIDE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Collide</title></head><body><h1>Collide</h1>
<input type="password" aria-label="Pin" oninput="this.type = 'text'; if (!document.getElementById('go')) { const b = document.createElement('button'); b.id = 'go'; b.textContent = 'Continue'; b.onclick = () => { const h = document.getElementById('hits'); h.textContent = String(Number(h.textContent) + 1) }; document.body.appendChild(b) }">
<p id="hits">0</p><p id="glued">-</p>
<input type="password" aria-label="Short" oninput="this.type = 'text'; document.getElementById('glued').textContent = 'A' + this.value + 'B'">
</body></html>`;
// Sixth review: typing into the password field replaces the whole list (a full page for the reply, which is withheld)
// and shows the typed value for 1.5 s, then the page removes it by itself (with ?stay the value stays shown). The field
// stays a password field.
const BASE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Base</title></head><body><h1>Account</h1>
<input type="password" aria-label="Code" oninput="const e = document.getElementById('echo'); e.textContent = 'Echo ' + this.value; clearTimeout(window.t); if (!location.search.includes('stay')) window.t = setTimeout(() => { e.textContent = 'Echo cleared' }, 1500); const l = document.getElementById('list'); if (!l.dataset.n) { l.dataset.n = '1'; l.innerHTML = Array.from({ length: 16 }, (_, i) => '<li>New row ' + (i + 1) + '</li>').join('') }">
<p id="echo">Echo none</p>
<ul id="list">${Array.from({ length: 6 }, (_, i) => `<li>Old item ${i + 1}</li>`).join("")}</ul>
</body></html>`;
// Seventh review: a batch step that moves to a new document whose address holds a field's value (a configured secret).
const MOVE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Move</title></head><body><h1>Move</h1>
<input aria-label="Token"><button onclick="location.href = '/landing?k=' + encodeURIComponent(document.querySelector('input').value)">Go</button><button>Other</button>
</body></html>`;
// Output-guard tightening (18 Nov). A page that echoes what is typed into each field, in one chosen form
// (?form=raw|uri|json|b64|none), into a status line, and tells the fixture server what each field holds (as code points: no form of it the guard knows) and when Next is
// pressed (its own beacon to /tight-log, ?t= tags the page): independent proof of what was typed, never read through
// the MCP.
const tightHtml = (form: string, tag: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Tight</title></head><body><h1>Tight</h1>
<input type="password" aria-label="Pass" oninput="show('pass', this.value)"><input aria-label="Note" oninput="show('note', this.value)">
<p id="st">-</p><button onclick="fetch('/tight-log?f=next&t=${tag}&v=')">Next</button>
<script>
function show(field, v) {
  fetch('/tight-log?f=' + field + '&t=${tag}&v=' + Array.from(v).map((ch) => ch.codePointAt(0)).join('.'));
  const f = ${JSON.stringify(form)};
  if (f === 'none') return;
  document.getElementById('st').textContent = 'Echo ' + (f === 'uri' ? encodeURI(v) : f === 'json' ? JSON.stringify(v) : f === 'b64' ? btoa(unescape(encodeURIComponent(v))) : v);
}
</script></body></html>`;
// A view change that only changes the address (pushState), then a real new document (17 Nov).
const SPA_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body><h1>View 1</h1>
<button onclick="history.pushState({}, '', '/spa?view=2'); document.querySelector('h1').textContent = 'View 2'">Next view</button></body></html>`;
// A search that draws its filter buttons before its tabs, as Google Flights does (17 Nov).
const TABS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Flights</title></head><body><h1>Flights</h1>
<button onclick="go()">Search</button><div id="r"></div>
<script>function go(){ document.getElementById('r').innerHTML = ['1 passenger','All filters','Stops','Airlines','Bags','Price']
  .map(b => '<button>' + b + '</button>').join('') + '<div role="tablist"><div role="tab" aria-selected="true" tabindex="0">Best</div><div role="tab" aria-selected="false" tabindex="-1">Cheapest from ₹9,584</div></div><p>IndiGo ₹9,584</p>'; }</script></body></html>`;
const SORTS: Record<string, string> = { relevance: "relevance", "price-asc": "price, low to high" };
const SHOP_PRICES = [1499, 3279, 1973, 8118, 1899, 2499, 999, 4599, 1799, 2999, 1299, 6499];
const shopHtml = (q: URLSearchParams) => {
  const term = q.get("q") ?? "";
  const page = Number(q.get("page") ?? "1") || 1;
  const sort = SORTS[q.get("sort") ?? "relevance"] ? q.get("sort") ?? "relevance" : "relevance";
  const under = q.get("price") === "under-2000";
  const filter = under ? "under ₹2,000" : "none";
  const at = (extra: string) => `/shop?q=${encodeURIComponent(term)}${extra}`;
  if (q.has("sid") && q.get("sid") !== "s-issued-by-shop")
    return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body><h1>Your session has expired. Sign in to continue.</h1></body></html>`;
  const rows = SHOP_PRICES.map((p, i) => ({ n: (page - 1) * 12 + i + 1, p })).filter((r) => !under || r.p < 2000);
  if (sort === "price-asc") rows.sort((a, b) => a.p - b.p);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title></head><body>
<form action="/shop"><input name="q" aria-label="Search" value="${esc(term)}"> <select name="price" aria-label="Price"><option value="">Any price</option><option value="under-2000">Under ₹2,000</option></select> <button>Search</button></form>
<h1>Results for "${esc(term)}" — page ${page}, sorted by ${SORTS[sort]}, filters: ${filter}</h1>
<a href="${at(`&page=${page + 1}`)}">Next page</a> <a href="${at("&sort=price-asc")}">Price: low to high</a> <a href="${at("&price=under-2000")}">Under ₹2,000</a>
<a href="${at("&ref=sr_nav_tracking_campaign_2026_winter_sale_banner_slot_4&qid=1794905301&xpid=Mf1U2CCM_gaCS_long")}">Featured picks</a>
${rows.map((r) => `<p class="item">Item ${r.n} — ₹${r.p.toLocaleString("en-IN")}</p>`).join("")}</body></html>`;
};
// A list whose rows swap a value, re-sort, or move to another address with the same content.
const SORT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Stays</title></head><body><h1>Stays</h1><ul id="l">
<li><a href="#a">Hotel Aurora</a><p>Score 9.1</p></li><li><a href="#b">Hotel Borealis</a><p>Score 9.8</p></li>
<li><a href="#c">Hotel Cirrus</a><p>Score 8.7</p></li><li><a href="#d">Hotel Dune</a><p>Score 10</p></li></ul>
<button onclick="swap()">Swap</button><button onclick="sortIt()">Sort by score</button><button onclick="history.pushState({}, '', '/sort?page=2')">Page 2</button>
<button onclick="location.hash='v2'">Hash view</button><button onclick="location.reload()">Reload</button><button onclick="document.querySelector('h1').textContent='Stays (4)'">Count</button>
${Array.from({ length: 30 }, (_, i) => `<p>Note ${i + 1}: free cancellation on most stays</p>`).join("")}
<script>const ps=()=>[...document.querySelectorAll('#l p')];
function swap(){ const [a,b]=ps(); const t=a.textContent; a.textContent=b.textContent; b.textContent=t; }
function sortIt(){ const l=document.getElementById('l'); [...l.children].sort((x,y)=>parseFloat(y.querySelector('p').textContent.slice(6))-parseFloat(x.querySelector('p').textContent.slice(6))).forEach(li=>l.appendChild(li)); }</script></body></html>`;

// A tab that is marked selected at once and whose list is sorted later (18 Nov: Google Flights' Cheapest tab kept the
// Best list a few seconds after the click), a tab that changes no list, and the delay from the address.
const TABSORT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fares</title></head><body><h1>Fares</h1>
<div role="tablist" aria-label="Order"><button role="tab" aria-selected="true" onclick="pick(this,'best')">Best</button><button role="tab" aria-selected="false" onclick="pick(this,'cheap')">Cheapest</button><button role="tab" aria-selected="false" onclick="pick(this,'still')">Unchanged</button></div>
<p id="sorted">Sorted by top flights</p><ul id="fares"><li>Air A ₹10,041</li><li>Air B ₹9,584</li><li>Air C ₹9,420</li></ul>
<script>const delay = Number(new URLSearchParams(location.search).get('delay') || 0);
const price = (li) => +li.textContent.replace(/[^0-9]/g, '');
function pick(t, k) { for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', b === t ? 'true' : 'false'); if (k === 'still') return;
  setTimeout(() => { const l = document.getElementById('fares'); const items = [...l.children].sort((x, y) => price(x) - price(y)); if (k === 'best') items.reverse(); items.forEach((li) => l.appendChild(li)); document.getElementById('sorted').textContent = k === 'cheap' ? 'Sorted by price' : 'Sorted by top flights'; }, delay); }</script></body></html>`;

// C1a (18 Nov): a page whose heading, a field, an element near the top, one far below the printed screens and one that
// goes away all change on their own buttons; an address change (pushState) and a reload; text enough for change lists.
const C1_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Stays</title></head><body><h1 id="h">Stays</h1>
<button onclick="document.getElementById('h').textContent=document.getElementById('h').textContent+'+'">Count</button>
<button onclick="const b=document.createElement('button'); b.textContent='Here button'; document.getElementById('here').appendChild(b)">Add here</button><div id="here"></div>
<button onclick="const b=document.createElement('button'); b.textContent='Far button'; document.getElementById('far').appendChild(b)">Add far</button>
<button id="gadget">Gadget</button><button onclick="document.getElementById('gadget').remove()">Hide gadget</button>
<label for="where">Where</label><input id="where">
<button onclick="history.pushState({}, '', '/c1?view=2')">Push view</button><button onclick="location.reload()">Reload</button>
${Array.from({ length: 30 }, (_, i) => `<p>Note ${i + 1}: free cancellation on most stays</p>`).join("")}
<div style="height:9000px"></div><div id="far"></div></body></html>`;
// C1a' (18 Nov): a Count button at the top, 5 buttons a little more than a screen down (inside browser_snapshot's
// printing, below the visible screen) and 7 far down (below both).
const C1LONG_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Long</title></head><body><h1 id="h">Long</h1>
<button onclick="document.getElementById('h').textContent=document.getElementById('h').textContent+'+'">Count</button>
${Array.from({ length: 30 }, (_, i) => `<p>Note ${i + 1}: free cancellation on most stays</p>`).join("")}
<div style="height:100px"></div>${Array.from({ length: 5 }, (_, i) => `<button>Near ${i + 1}</button>`).join("")}
<div style="height:6000px"></div>${Array.from({ length: 7 }, (_, i) => `<button>Far ${i + 1}</button>`).join("")}</body></html>`;
// C1a' (18 Nov): a long page with every control in the first screen: nothing interactive above or below it.
const C1ZERO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Short</title></head><body><h1 id="h">Short</h1>
<button onclick="document.getElementById('h').textContent=document.getElementById('h').textContent+'+'">Count</button>
${Array.from({ length: 60 }, (_, i) => `<p>Line ${i + 1}: plain text with no control in it</p>`).join("")}</body></html>`;
// C1a: a password field whose value the page shows until Clear is pressed (every reply that would show it is withheld).
const C1BASE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Account</title></head><body><h1 id="h">Account</h1>
<input type="password" aria-label="Code" oninput="document.getElementById('echo').textContent='Echo '+this.value">
<p id="echo">Echo none</p><button onclick="document.getElementById('echo').textContent='Echo cleared'">Clear</button>
<button onclick="document.getElementById('h').textContent=document.getElementById('h').textContent+'+'">Count</button>
${Array.from({ length: 30 }, (_, i) => `<p>Line ${i + 1}: account settings apply to every device</p>`).join("")}</body></html>`;

const textOf = (r: unknown): string => ((r as CallToolResult).content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

async function connect(pf: PilotfishMcp, capabilities: ConstructorParameters<typeof Client>[1] = {}): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await pf.server.connect(serverSide);
  const client = new Client({ name: "e2e", version: "1" }, capabilities);
  await client.connect(clientSide);
  return client;
}

describe.skipIf(!E2E)("mcp server e2e", () => {
  let site: Server;
  /** Every request the fixture server received, in order (independent proof of what a page sent or loaded). */
  const received: string[] = [];
  let origin: string;
  let pf: PilotfishMcp;
  let client: Client;

  beforeAll(async () => {
    site = createServer((req, res) => {
      received.push(req.url ?? "");
      if (req.method === "POST" && (req.url ?? "").startsWith("/fail")) {
        res.writeHead(500, { "content-type": "text/plain" });
        return void res.end("refused");
      }
      res.writeHead(200, { "content-type": "text/html" });
      const u = req.url ?? "/";
      if (u.startsWith("/stays")) return void res.end(staysHtml(new URL(u, "http://x").searchParams));
      if (u.startsWith("/shop")) return void res.end(shopHtml(new URL(u, "http://x").searchParams));
      if (u.startsWith("/tabs")) return void res.end(TABS_HTML);
      if (u.startsWith("/spa")) return void res.end(SPA_HTML);
      if (u.startsWith("/batch")) return void res.end(batchHtml(new URL(u, "http://x").searchParams.get("mode") ?? "dialog"));
      if (u.startsWith("/fields")) return void res.end(FIELDS_HTML);
      if (u.startsWith("/expect")) return void res.end(EXPECT_HTML);
      if (u.startsWith("/review")) return void res.end(R_HTML);
      if (u.startsWith("/secret")) return void res.end(SECRET_HTML);
      if (u.startsWith("/echo")) return void res.end(ECHO_HTML);
      if (u.startsWith("/glue")) return void res.end(GLUE_HTML);
      if (u.startsWith("/collide")) return void res.end(COLLIDE_HTML);
      if (u.startsWith("/base")) return void res.end(BASE_HTML);
      if (u.startsWith("/moveto")) return void res.end(MOVE_HTML);
      if (u.startsWith("/tight-log")) return void res.end("ok");
      if (u.startsWith("/tight")) return void res.end(tightHtml(new URL(u, "http://x").searchParams.get("form") ?? "raw", (new URL(u, "http://x").searchParams.get("t") ?? "").replace(/[^a-zA-Z0-9]/g, "")));
      if (u.startsWith("/c1base")) return void res.end(C1BASE_HTML);
      if (u.startsWith("/c1zero")) return void res.end(C1ZERO_HTML);
      if (u.startsWith("/c1long")) return void res.end(C1LONG_HTML);
      if (u.startsWith("/c1")) return void res.end(C1_HTML);
      if (u.startsWith("/late")) return void res.end(LATE_HTML);
      if (u.startsWith("/scope2")) return void res.end(scopeHtml(true));
      if (u.startsWith("/scope1")) return void res.end(scopeHtml(false));
      if (u.startsWith("/reground")) return void res.end(regroundHtml(new URL(u, "http://x").searchParams.get("mode") ?? "reorder"));
      res.end(u.startsWith("/tablag") ? TABSORT_HTML : u.startsWith("/waitq") ? WAITQ_HTML : u.startsWith("/aria-hidden") ? ARIA_HIDDEN_HTML : u.startsWith("/pick") ? PICK_HTML : u.startsWith("/quiet") ? QUIET_HTML : u.startsWith("/widget") ? WIDGET_HTML : u.startsWith("/suggest") ? SUGGEST_HTML : u.startsWith("/fares") ? FARES_HTML : u.startsWith("/sort") ? SORT_HTML : u.startsWith("/loading") ? LOADING_HTML : u.startsWith("/spinner") ? SPINNER_HTML : u.startsWith("/otp") ? OTP_HTML : u.startsWith("/results") ? RESULTS_HTML : u.startsWith("/signin") ? SIGNIN_HTML : u.startsWith("/robot") ? ROBOT_HTML : u.startsWith("/blocked") ? BLOCKED_HTML : HOME_HTML);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const config: McpConfig = {
      headless: true,
      allowedHosts: ["127.0.0.1"],
      allowPrivateNetwork: true,
      secrets: { pw: { value: SECRET } },
      interventionTimeoutMs: 30_000,
      allowScreenshots: true,
    };
    pf = createMcpServer({ config });
    client = await connect(pf);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await pf?.close();
    site?.close();
  });

  it("drives the page with direct tools: refs, evidence, policy, no secret values", async () => {
    const nav = await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/` } });
    expect(nav.isError, textOf(nav)).toBeFalsy();
    expect(textOf(nav)).toContain("EVIDENCE");
    expect(textOf(nav)).toContain(`navigated: about:blank → ${origin}/`);

    const snap = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    const ref = (re: RegExp) => {
      const m = re.exec(snap);
      if (!m) throw new Error(`no match for ${re} in:\n${snap}`);
      return m[1]!;
    };
    const launch = ref(/\[(e\d+)\]<button[^\n]*Launch/);
    const token = ref(/\[(e\d+)\]<input[^\n]*id="tok"/);
    const size = ref(/\[(e\d+)\]<select[^\n]*/);

    const click = textOf(await client.callTool({ name: "browser_click", arguments: { ref: launch } }));
    expect(click).toContain("EVIDENCE");
    expect(click).toContain("Launched the probe");

    // The value is typed by the broker; the field then shows no value (18 Nov: masked, never a readable placeholder).
    const typed = await client.callTool({ name: "browser_type", arguments: { ref: token, text: "{{pw}}" } });
    expect(typed.isError).toBeFalsy();
    expect(textOf(typed)).toMatch(/value e\d+: "" → "•+/);
    expect(textOf(typed)).not.toContain(SECRET);
    const pageText = textOf(await client.callTool({ name: "browser_get_text", arguments: {} }));
    expect(pageText).toContain("Launched the probe");
    expect(pageText).not.toContain(SECRET);

    // Reading only what is needed: a read-only expression (secrets masked, writes refused), refs by words, a capped text.
    // A read of the secret's own value is withheld whole (18 Nov), with or without a schema (before validation).
    const q = await client.callTool({ name: "browser_query", arguments: { expression: "[document.title, document.getElementById('tok').value]" } });
    expect(textOf(q)).toMatch(/^UNSAFE_OUTPUT/);
    expect(q.isError).toBe(true);
    expect(textOf(q)).not.toContain(SECRET);
    expect(q.structuredContent).toBeUndefined();
    const secretRead = "[document.title, document.getElementById('tok').value]";
    const withheldQ = await client.callTool({ name: "browser_query", arguments: { expression: secretRead, schema: { type: "array", items: { type: "string" }, minItems: 2 } } });
    expect(textOf(withheldQ)).toMatch(/^UNSAFE_OUTPUT/);
    expect(withheldQ.structuredContent).toBeUndefined();
    expect(JSON.stringify(withheldQ)).not.toContain(SECRET);
    // The field state, read without its value: the broker typed all of it.
    const lenQ = textOf(await client.callTool({ name: "browser_query", arguments: { expression: "document.getElementById('tok').value.length" } }));
    expect(lenQ.split("\n")[0]).toBe(String(SECRET.length));
    // With a schema: the same reply plus the value; a result that does not match is an error naming where.
    const expression = "[document.title, document.getElementById('size').value]";
    const plainQ = await client.callTool({ name: "browser_query", arguments: { expression } });
    const typedQ = await client.callTool({ name: "browser_query", arguments: { expression, schema: { type: "array", items: { type: "string" }, minItems: 2 } } });
    expect(typedQ.isError).toBeFalsy();
    expect(textOf(typedQ)).toBe(textOf(plainQ));
    expect((typedQ.structuredContent as { value: string[] }).value[0]).toBe("Console");
    expect(JSON.stringify(typedQ.structuredContent)).not.toContain(SECRET);
    const wrong = await client.callTool({ name: "browser_query", arguments: { expression, schema: { type: "array", items: { type: "number" } } } });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toMatch(/^ERROR schema_mismatch\n\/0: must be number\n\/1: must be number\nNext: fix the expression and run browser_query again\.$/);
    expect(textOf(wrong)).not.toContain(SECRET);
    const write = await client.callTool({ name: "browser_query", arguments: { expression: "document.querySelector('button').click()" } });
    expect(write.isError).toBe(true);
    expect(textOf(write)).toMatch(/read-only/i);
    const found = textOf(await client.callTool({ name: "browser_find", arguments: { query: "Launch button" } }));
    expect(found).toMatch(/\[e\d+\]<button[^\n]*Launch/);
    const short = textOf(await client.callTool({ name: "browser_get_text", arguments: { max_chars: 500 } }));
    expect(short.length).toBeLessThan(700);
    expect((await client.callTool({ name: "browser_wait", arguments: { seconds: 0.5 } })).isError).toBeFalsy();
    // Several steps in one call: they run in order, and stop at the first that fails.
    const batch = textOf(await client.callTool({ name: "browser_actions", arguments: { actions: [{ action: "select", ref: size, values: ["Small"] }, { action: "press", key: "Tab" }] } }));
    expect(batch).toMatch(/^1\. [^\n]*\n(?: {3}[^\n]*\n)*2\. /);
    const broken = await client.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: "e999" }, { action: "press", key: "Tab" }] } });
    expect(broken.isError).toBe(true);
    expect(textOf(broken)).toMatch(/1\. FAILED[^\n]*\nStopped: steps 2-2 were not run/);

    const selected = textOf(await client.callTool({ name: "browser_select", arguments: { ref: size, values: ["Large"] } }));
    expect(selected).toContain("Selected: Large");

    expect((await client.callTool({ name: "browser_press", arguments: { key: "Tab" } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "browser_scroll", arguments: { direction: "down" } })).isError).toBeFalsy();

    const shot = (await client.callTool({ name: "browser_screenshot", arguments: {} })) as CallToolResult;
    expect(shot.content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });

    expect(textOf(await client.callTool({ name: "browser_tabs", arguments: {} }))).toBe(`t1 (current) ${origin}/`);

    // A stale or unknown ref fails with a reason instead of clicking something else.
    const missing = await client.callTool({ name: "browser_click", arguments: { ref: "e999" } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/No element with ref e999/);

    // An irreversible-looking click needs a person; this client cannot ask one (no elicitation).
    const del = await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Delete draft/) } });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toMatch(/Blocked by policy: Target looks irreversible.*cannot ask/);

    // Policy before action: only 127.0.0.1 is allowed (localhost is another host).
    const blocked = await client.callTool({ name: "browser_navigate", arguments: { url: origin.replace("127.0.0.1", "localhost") + "/" } });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain("Blocked by policy");
  }, 90_000);

  it("asks the person through elicitation when the client supports it: an irreversible click goes ahead on their yes", async () => {
    // A second connection (same browser) whose client can show forms to its user.
    const second = createMcpServer({ session: pf.session });
    const asker = await connect(second, { capabilities: { elicitation: {} } });
    const asked: string[] = [];
    asker.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push((req.params as { message: string }).message);
      return { action: "accept", content: { answer: "yes" } };
    });
    try {
      // The irreversible click the first client could not make goes ahead once the person confirms.
      await asker.callTool({ name: "browser_navigate", arguments: { url: `${origin}/` } });
      const snap = textOf(await asker.callTool({ name: "browser_snapshot", arguments: {} }));
      const del = /\[(e\d+)\]<button[^\n]*Delete draft/.exec(snap)?.[1];
      const clicked = await asker.callTool({ name: "browser_click", arguments: { ref: del! } });
      expect(clicked.isError).toBeFalsy();
      expect(textOf(clicked)).toContain("Draft deleted");
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/^Confirm action Press “Delete draft” on 127\.0\.0\.1\? It deletes or removes something\./);
    } finally {
      await asker.close();
      await second.close();
    }
  }, 120_000);

  it("an action returns the visible screen of a long results page, with counts; refs below it work after a scroll (4 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/results` } }));
    expect(nav).toContain("Result 1 ");
    expect(nav).not.toContain("Result 60 ");
    expect(nav).toMatch(/\((\d+) interactive elements below the viewport; scroll down to reveal\)/);
    const below = Number(/\((\d+) interactive elements below the viewport/.exec(nav)![1]);
    expect(below).toBeGreaterThan(40);
    // browser_snapshot still gives three screens, whole_page everything.
    const three = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    const refsShown = (t: string) => (t.slice(t.indexOf("PAGE SNAPSHOT")).match(/\[e\d+\]/g) ?? []).length;
    expect(refsShown(three)).toBeGreaterThan(refsShown(nav) * 1.8);
    expect(textOf(await client.callTool({ name: "browser_snapshot", arguments: { whole_page: true } }))).toContain("Result 60 ");
    // A scroll brings the next screen and its refs, which click.
    let seen = nav;
    for (let i = 0; i < 12 && !/\[(e\d+)\]<a[^\n]*Result 30 /.test(seen); i++) seen = textOf(await client.callTool({ name: "browser_scroll", arguments: { direction: "down" } }));
    const r30 = /\[(e\d+)\]<a[^\n]*Result 30 /.exec(seen)![1]!;
    expect(seen).toMatch(/interactive elements above the viewport/);
    const clicked = textOf(await client.callTool({ name: "browser_click", arguments: { ref: r30 } }));
    expect(clicked).toContain("/results#r30");
    // Any hint for more names this server's tools, never the agent's own.
    expect(nav + three + seen).not.toMatch(/read_page\(rootRef\)|use find\(\)/);
  });

  it("a page only a person can pass says so in the result; browser_resume waits for them and goes on (4 Nov)", async () => {
    // A sign-in: what it needs, where (the pilotfish window), and what to call after; no attempt to get past it.
    // Headless (this server): it says so, since nobody can sign in by hand there.
    const headless = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/signin` } }));
    expect(headless).toMatch(/NEEDS A PERSON \(login[^)]*\): .*asks to sign in/);
    expect(headless).toContain("This browser is headless");
    expect(headless).toContain("Docs: https://pilotfish.gai.ventures/docs/open-settings");
    // With a window (the default where one can be shown): the person does it there, then browser_resume.
    pf.session.config.headless = false;
    const signin = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/signin` } }));
    expect(signin).toMatch(/NEEDS A PERSON \(login[^)]*\): .*asks to sign in/);
    expect(signin).toContain("pilotfish browser window is open on it");
    expect(signin).toContain("browser_resume");
    expect(signin).toMatch(/\nDocs: https:\/\/pilotfish\.gai\.ventures\/docs\/open$/);
    // Still there: browser_resume says so (not an error), with the same request.
    const waiting = await client.callTool({ name: "browser_resume", arguments: { timeout_s: 5 } });
    expect(waiting.isError).toBeFalsy();
    expect(textOf(waiting)).toMatch(/NEEDS A PERSON \(login[\s\S]*Still waiting after 5 s/);
    // The person signs in in the window (here: the page moves on); browser_resume returns the page as it is now.
    const tab = await pf.session.page();
    const resumed = client.callTool({ name: "browser_resume", arguments: { timeout_s: 30 } });
    setTimeout(() => void tab.navigate(`${origin}/`).catch(() => undefined), 1_500);
    const after = textOf(await resumed);
    expect(after).toContain("The page needs nobody now");
    expect(after).toContain("Launch");
    // A one-time code: the person types it in the window; a CAPTCHA: the person solves it; a block: nobody can.
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/otp` } }))).toMatch(/NEEDS A PERSON \(otp[^)]*\): [^\n]*Please type the code/);
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/robot` } }))).toMatch(/NEEDS A PERSON \(captcha/);
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/blocked` } }))).toMatch(/BLOCKED: .*refused automated access/);
    // snapshot:false leaves the screen out, never what needs a person or blocks the page (17 Nov).
    const quietRobot = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/robot?q=1`, snapshot: false } }));
    expect(quietRobot).toMatch(/NEEDS A PERSON \(captcha/);
    expect(quietRobot).not.toContain("PAGE SNAPSHOT");
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/blocked?q=1`, snapshot: false } }))).toMatch(/BLOCKED: .*refused automated access/);
    // An ordinary page: nothing added.
    expect(textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/` } }))).not.toMatch(/NEEDS A PERSON|BLOCKED|STOP:/);
    pf.session.config.headless = true;
  }, 120_000);

  it("each screen once: an action on a page just shown returns the lines that changed; navigate can leave the screen out (4 Nov)", async () => {
    await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/results` } });
    const home = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/` } }));
    expect(home).toContain("PAGE SNAPSHOT");
    expect(home).toContain("<h1>Console");
    expect(home.slice(home.indexOf("PAGE SNAPSHOT"))).not.toMatch(/<\/(button|h1|label)>/);
    const launch = /\[(e\d+)\]<button[^\n]*Launch/.exec(home)![1]!;
    const click = textOf(await client.callTool({ name: "browser_click", arguments: { ref: launch } }));
    expect(click).toContain("EVIDENCE");
    expect(click).toMatch(/PAGE SNAPSHOT \([^)]*\): CHANGES ONLY since the page snapshot 1 browser result back/);
    expect(click).toContain("Launched the probe");
    // Lines it already has are not repeated, and their refs still work.
    expect(click).not.toContain("Access token");
    const size = /\[(e\d+)\]<select/.exec(home)![1]!;
    expect((await client.callTool({ name: "browser_select", arguments: { ref: size, values: ["Large"] } })).isError).toBeFalsy();
    // snapshot:false: what happened, no screen; browser_snapshot shows it.
    const quiet = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/results`, snapshot: false } }));
    expect(quiet).toContain(`navigated: ${origin}/ → ${origin}/results`);
    expect(quiet).toContain("No page snapshot, as asked");
    expect(quiet).not.toContain("PAGE SNAPSHOT");
    // The evidence keeps its bounded lists (the first five new elements and texts), not the screen.
    expect(quiet).toContain("120 new interactive element(s)");
    expect(quiet).not.toContain("Result 6 ");
    expect(textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }))).toContain("Result 1 ");
  }, 60_000);

  it("snapshot:false still reports where it landed, the title, the evidence and the page's own loading, with no screen (17 Nov)", async () => {
    const quiet = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/loading?q=2`, snapshot: false } }));
    expect(quiet).toContain(`→ ${origin}/loading?q=2`);
    expect(quiet).toMatch(/title: [^\n]*"Flights"/);
    expect(quiet).toMatch(/Waited \d+\.\d s for the page's own loading indicator to finish/);
    expect(quiet).toContain("No page snapshot, as asked");
    expect(quiet).not.toContain("PAGE SNAPSHOT");
    // The evidence is as without a page: its lists (new elements, new text) are kept, bounded as always.
    expect(quiet).toMatch(/- 3 new interactive element\(s\): \[e\d+\]/);
    expect(quiet).toContain('new text: "Flights"');
  }, 60_000);

  it("snapshot:false on an acting tool leaves out only the printed page; the next page is a change list against the last one shown (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/quiet` } }));
    const ref = (re: RegExp, t = nav) => re.exec(t)![1]!;
    const add = ref(/\[(e\d+)\]<button[^\n]*Add filter/);
    const num = (r: string) => Number(r.slice(1));
    // The structured evidence is all there (the new button with its ref, the new text, the settle), only no page.
    const q1 = textOf(await client.callTool({ name: "browser_click", arguments: { ref: add, snapshot: false } }));
    expect(q1).toMatch(/1 new interactive element\(s\): \[e\d+\]<button>Remove filter 1<\/button>/);
    expect(q1).toContain('new text: "Remove filter 1"');
    expect(q1).toMatch(/- \d+ request\(s\)[^\n]*|- no network[^\n]*/);
    expect(q1).toMatch(/network idle, DOM quiet/);
    expect(q1).toContain("No page snapshot, as asked");
    expect(q1).not.toContain("PAGE SNAPSHOT");
    const r1 = ref(/\[(e\d+)\]<button>Remove filter 1/, q1);
    // A secret typed quietly: the value change is in the evidence, masked.
    const typed = await client.callTool({ name: "browser_type", arguments: { ref: ref(/\[(e\d+)\]<input[^\n]*id="tok"/), text: "{{pw}}", snapshot: false } });
    expect(typed.isError).toBeFalsy();
    expect(textOf(typed)).toMatch(/value e\d+: "" → "•+/);
    expect(textOf(typed)).not.toContain(SECRET);
    expect(textOf(typed)).not.toContain("PAGE SNAPSHOT");
    // Refs go on counting across quiet results: a new element never reuses a number.
    const q3 = textOf(await client.callTool({ name: "browser_click", arguments: { ref: add, snapshot: false } }));
    const r2 = ref(/\[(e\d+)\]<button>Remove filter 2/, q3);
    expect(num(r2)).toBeGreaterThan(num(r1));
    // The next printed page is against the navigate's screen (the last one shown), 4 results back, never a quiet one:
    // it lists both new buttons with the refs the quiet results gave them, and applies to that screen.
    const shown = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Toggle/) } }));
    expect(shown).toMatch(/CHANGES ONLY since the page snapshot 4 browser results back/);
    expect(shown).toContain(`[${r1}]<button>Remove filter 1`);
    expect(shown).toContain(`[${r2}]<button>Remove filter 2`);
    const body = (t: string) => t.slice(t.indexOf("\n", t.indexOf("PAGE SNAPSHOT (")) + 1);
    const rebuilt = applyInOrder(body(nav), body(shown)).join("\n");
    expect(rebuilt).toMatch(/<h1>Filters\n[^]*Add filter\n[^]*Toggle\n\[e\d+\]<button[^\n]*Add many\nOn\n<label>Access token\n[^]*Remove filter 1\n[^]*Remove filter 2\n[^]*Delete draft/);
    expect(rebuilt).not.toMatch(/\nOff(\n|$)/);
    // The printed-base contract, apart: a fresh read (browser_snapshot, whole) never becomes the base; the next printed
    // reply (the toggle clicked back, a printed change) is still relative to the navigate's screen, never to that read
    // (1 back) nor to a quiet reply. Its ref is taken from that fresh read. (An idle browser_wait prints no page.)
    const read = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    const after = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Toggle/, read) } }));
    const back = /(?:CHANGES ONLY since|the same as) the page snapshot (\d+) browser results? back/.exec(after);
    expect(back, after).toBeTruthy();
    expect(Number(back![1]), after).toBeGreaterThan(1);
    // Current refs for the next steps, from a fresh read of the page as it is now (never refs kept from earlier replies).
    const current = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    // Policy, then a page only a person can pass, still checked with the flag.
    const del = await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Delete draft/, current), snapshot: false } });
    expect(del.isError).toBe(true);
    expect(textOf(del)).toMatch(/Blocked by policy: Target looks irreversible/);
    const otp = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<a[^\n]*Verify/, current), snapshot: false } }));
    expect(otp).toMatch(/NEEDS A PERSON \(otp/);
    expect(otp).toContain(`navigated: ${origin}/quiet → ${origin}/otp`);
    // Several steps quietly: a line per step and the evidence of the last, no page.
    const nav2 = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/quiet?2` } }));
    const steps = textOf(await client.callTool({ name: "browser_actions", arguments: { snapshot: false, actions: [{ action: "click", ref: ref(/\[(e\d+)\]<button[^\n]*Add filter/, nav2) }, { action: "click", ref: ref(/\[(e\d+)\]<button[^\n]*Toggle/, nav2) }] } }));
    expect(steps).toMatch(/^1\. [^\n]*\n(?: {3}[^\n]*\n)*2\. /);
    expect(steps).toContain("EVIDENCE");
    expect(steps).not.toContain("PAGE SNAPSHOT");
    // navigate's quiet reply: the evidence's counts and lists; the screen's above/below counts are not in it.
    const quietNav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/results?quiet`, snapshot: false } }));
    expect(quietNav).toMatch(/- \d+ new interactive element\(s\): \[e\d+\]/);
    expect(quietNav).not.toMatch(/below the viewport|above the viewport/);
  }, 90_000);

  it("a pick between look-alike suggestions is said in the page's words; the results page's heading and breadcrumb come with the evidence (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/pick` } }));
    const ref = (re: RegExp, t = nav) => re.exec(t)![1]!;
    const city = ref(/\[(e\d+)\]<@option[^\n]*Lakes/);
    const picked = textOf(await client.callTool({ name: "browser_click", arguments: { ref: city } }));
    expect(picked).toContain('Chose option 2 of 3 in "Suggested destinations": "North ridge Lakes (North Ridge), Westland"');
    // Printed: the heading and breadcrumb are on the screen, so the evidence does not repeat them.
    const search = ref(/\[(e\d+)\]<button[^\n]*Search/);
    const shown = textOf(await client.callTool({ name: "browser_click", arguments: { ref: search } }));
    expect(shown).toContain("type=city");
    expect(shown).toContain("<h1>North ridge: 8 stays found");
    expect(shown).not.toContain("- page heading:");
    // Quiet: the same facts come in the evidence, in the page's own words, with the address it moved to.
    await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/pick?2` } });
    const nav2 = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<@option[^\n]*Lakes/, nav2) } });
    const quiet = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Search/, nav2), snapshot: false } }));
    expect(quiet).not.toContain("PAGE SNAPSHOT");
    expect(quiet).toMatch(/navigated: [^\n]*\/stays\?ss=North%20ridge[^\n]*type=city/);
    expect(quiet).toContain('- page heading: "North ridge: 8 stays found"');
    expect(quiet).toContain("- breadcrumb: Home › Westland › Lakes › North ridge");
  }, 90_000);

  it("a listbox that hides the background from assistive tech is a change list with exact evidence; actionability is the hit test's (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/aria-hidden` } }));
    const ref = (re: RegExp, t = nav) => re.exec(t)![1]!;
    // Before the capture fix every background element lost its name here: "N new, N removed" and the whole screen.
    const opened = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<@combobox/) } }));
    expect(opened).toMatch(/state: e\d+ expanded: false → true/);
    expect(opened).toMatch(/- 3 new interactive element\(s\)/);
    expect(opened).not.toMatch(/element\(s\) removed/);
    expect(opened).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
    expect(opened).toContain("One way");
    expect(opened).not.toContain("Tip 12");
    // aria-hidden is no visual state and blocks no click: the background button still works.
    const signIn = await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Sign in/) } });
    expect(signIn.isError, textOf(signIn)).toBeFalsy();
    expect(textOf(signIn)).toContain("Signed out");
    // A modal dialog makes the background inert: a ref given before it opened is found covered by the hit test, never
    // clicked through it; the existing cover handling (autoDismiss) closes the dialog by its own button and says so.
    expect((await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Offers/) } })).isError).toBeFalsy();
    const under = await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<input[^\n]*Where from/) } });
    expect(under.isError, textOf(under)).toBeFalsy();
    expect(textOf(under)).toMatch(/^Auto-dismissed \(it covered the target\): popup: [^\n]*Dismiss/);
    expect(textOf(under)).toMatch(/1 element\(s\) removed: \[e\d+\]<button[^\n]*Dismiss/);
  }, 90_000);

  it("a batch whose last step changed nothing still shows what its earlier steps did, never 'unchanged' of a screen the client never got (18 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/quiet?batch` } }));
    const add = /\[(e\d+)\]<button[^\n]*Add filter/.exec(nav)![1]!;
    const shown = textOf(await client.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: add }, { action: "wait", seconds: 1 }] } }));
    expect(shown).toMatch(/^1\. [^\n]*: changed/m);
    expect(shown).toContain("Remove filter 1");
    expect(shown).toContain("earlier steps of this call did, and the page as they left it is printed below");
    expect(shown).not.toContain("refs from the previous snapshot are still valid");
    // Quietly: no page, and no claim that the client's screen is current.
    const nav2 = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/quiet?batch2` } }));
    const add2 = /\[(e\d+)\]<button[^\n]*Add filter/.exec(nav2)![1]!;
    const quiet = textOf(await client.callTool({ name: "browser_actions", arguments: { snapshot: false, actions: [{ action: "click", ref: add2 }, { action: "wait", seconds: 1 }] } }));
    expect(quiet).not.toContain("PAGE SNAPSHOT");
    expect(quiet).toContain("browser_snapshot shows the page as they left it");
    expect(quiet).not.toContain("refs from the previous snapshot are still valid");
  }, 60_000);

  it("a tab whose list is sorted after the click: the reply and the next read see the sorted list; a tab that changes no list says so (18 Nov)", async () => {
    const ref = (re: RegExp, t: string) => re.exec(t)![1]!;
    const first = async () => textOf(await client.callTool({ name: "browser_query", arguments: { expression: "document.querySelector('#fares li').textContent" } }));
    // Sorted 1.5 s after the click: the click waits for it.
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tablag?delay=1500` } }));
    const t0 = Date.now();
    const cheap = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<@?(?:button|tab)[^\n]*Cheapest/, nav), snapshot: false } }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
    expect(cheap).toContain('Chose tab 2 of 3 in "Order": "Cheapest"');
    expect(cheap).not.toContain("had not changed");
    expect(await first()).toContain("₹9,420");
    // Sorted at once: no wait to speak of.
    const nav2 = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tablag?delay=0` } }));
    const t1 = Date.now();
    const fast = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<@?(?:button|tab)[^\n]*Cheapest/, nav2), snapshot: false } }));
    expect(Date.now() - t1).toBeLessThan(4_000);
    expect(fast).not.toContain("had not changed");
    expect(await first()).toContain("₹9,420");
    // A tab that changes no list: the reply says so after the wait.
    const still = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<@?(?:button|tab)[^\n]*Unchanged/, nav2), snapshot: false } }));
    expect(still).toContain("(The lists on screen had not changed 6 s after this choice");
    // A tab already selected: nothing to wait for.
    const nav3 = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tablag?delay=0` } }));
    const t2 = Date.now();
    const again = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<@?(?:button|tab)[^\n]*Best/, nav3), snapshot: false } }));
    expect(Date.now() - t2).toBeLessThan(4_000);
    expect(again).not.toContain("had not changed");
  }, 90_000);

  it("a suggestion list whose options share a name says so under the list, before the pick (19 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/suggest?same` } }));
    expect(nav).toMatch(/\(\[e\d+\], \[e\d+\] share the name "North Ridge": they are different places\./);
    expect(nav.indexOf("share the name")).toBeGreaterThan(nav.indexOf("Lakes (North Ridge), Westland"));
    expect(nav).not.toMatch(/share the name "North Ridge Inn/);
  }, 60_000);

  it("a suggestion picked below another of the same name is not clicked the first time; again, it is; the first of them always is (19 Nov)", async () => {
    const opt = (re: RegExp, t: string) => re.exec(t)![1]!;
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/suggest?refuse` } }));
    const lower = opt(/\[(e\d+)\]<@option[^\n]*North ridge/, nav);
    const first = await client.callTool({ name: "browser_click", arguments: { ref: lower } });
    expect(first.isError).toBe(true);
    expect(textOf(first)).toMatch(/^Not clicked yet: e\d+ is option 2 of 3 in "Suggestions": "North ridge[^"]*"\. Option 1, listed above it, has the same name: "North Ridge · Westland"/);
    expect(textOf(first)).toContain("click " + lower + " again only if the task names this smaller place");
    const again = await client.callTool({ name: "browser_click", arguments: { ref: lower } });
    expect(again.isError, textOf(again)).toBeFalsy();
    expect(textOf(again)).toContain("Chose option 2 of 3");
    // The first of the same-named options is clicked at once.
    const nav2 = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/suggest?refuse2` } }));
    const top = await client.callTool({ name: "browser_click", arguments: { ref: opt(/\[(e\d+)\]<@option[^\n]*North Ridge · Westland/, nav2) } });
    expect(top.isError, textOf(top)).toBeFalsy();
    expect(textOf(top)).toContain("Chose option 1 of 3");
  }, 60_000);

  it("no call spent on a retry (18 Nov): typing under a popup dismisses it as a click does; a missing get_text selector reads the page; an object query works", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/aria-hidden?type` } }));
    const ref = (re: RegExp, t = nav) => re.exec(t)![1]!;
    expect((await client.callTool({ name: "browser_click", arguments: { ref: ref(/\[(e\d+)\]<button[^\n]*Offers/) } })).isError).toBeFalsy();
    // The modal leaves the field covered and unfocusable: dismissed by its own button, then typed into.
    const typed = await client.callTool({ name: "browser_type", arguments: { ref: ref(/\[(e\d+)\]<input[^\n]*Where from/), text: "Mumbai" } });
    expect(typed.isError, textOf(typed)).toBeFalsy();
    expect(textOf(typed)).toMatch(/^Auto-dismissed \(it covered the target\): popup: [^\n]*Dismiss/);
    expect(textOf(await client.callTool({ name: "browser_query", arguments: { expression: "document.querySelector('input').value" } }))).toContain("Mumbai");
    // A selector that matches nothing: the page's whole text, said so, not an error.
    const text = await client.callTool({ name: "browser_get_text", arguments: { selector: "main#nowhere", max_chars: 2000 } });
    expect(text.isError).toBeFalsy();
    expect(textOf(text)).toMatch(/^\(No element matches the selector main#nowhere: the page's whole text follows\.\)\nPAGE TEXT \(/);
    expect(textOf(text)).toContain("Find a trip");
    // An object written as the whole expression is read as the object it means.
    const obj = textOf(await client.callTool({ name: "browser_query", arguments: { expression: "{title: document.title, tips: document.querySelectorAll('p').length}" } }));
    expect(obj).toContain('"title":"Trips"');
    expect(obj).toContain('"tips":25');
    // Code that throws for another reason is still reported.
    const bad = await client.callTool({ name: "browser_query", arguments: { expression: "{ nope( }" } });
    expect(textOf(bad)).toMatch(/query failed|SyntaxError/);
  }, 90_000);

  it("quiet replies never become the printed base, never diff across documents, and keep identity and protected facts (17 Nov review)", async () => {
    const ref = (re: RegExp, t: string) => re.exec(t)![1]!;
    // The printed base: /quiet.
    const base = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/quiet` } }));
    expect(base).toContain("PAGE SNAPSHOT");
    // Quiet navigate to another document: its identity facts (where, title or heading) are in the evidence.
    const qnav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/pick?quiet`, snapshot: false } }));
    expect(qnav).not.toContain("PAGE SNAPSHOT");
    expect(qnav).toContain(`navigated: ${origin}/quiet → ${origin}/pick?quiet`);
    expect(qnav).toMatch(/title: "Filters" → "Stays"|page heading: "Find a stay"/);
    expect(qnav).toContain('page heading: "Find a stay"');
    // A quiet action there; its ref came from quiet evidence, never from a printed screen.
    const opt = ref(/\[(e\d+)\]<@option[^;\n]*Lakes/, qnav);
    const qclick = textOf(await client.callTool({ name: "browser_click", arguments: { ref: opt, snapshot: false } }));
    expect(qclick).toContain("Chose option 2 of 3");
    // The next printed reply is a whole screen: the client's base is /quiet, another document; no change list across.
    const shown = textOf(await client.callTool({ name: "browser_find", arguments: { query: "Search" } }));
    const search = ref(/\[(e\d+)\]<button[^\n]*Search/, shown);
    const printed = textOf(await client.callTool({ name: "browser_click", arguments: { ref: search } }));
    expect(printed).toContain("PAGE SNAPSHOT");
    expect(printed).not.toContain("CHANGES ONLY");
    // A ref the client never saw printed, unchanged by the quiet steps, comes whole with its line (here on the results
    // page after the search: its breadcrumb links are on the screen with their refs).
    expect(printed).toMatch(/\[e\d+\]<a href="\/w">Westland/);
  }, 90_000);

  it("a quiet action that adds more elements than the evidence lists still says every protected change, and how many were left out (17 Nov review)", async () => {
    // A fresh browser: an earlier test filled the same "Access token" field from {{pw}}, which keeps it masked in this tab.
    await client.callTool({ name: "browser_close", arguments: {} });
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/quiet?many` } }));
    const many = /\[(e\d+)\]<button[^\n]*Add many/.exec(nav)![1]!;
    const tok = /\[(e\d+)\]<input[^\n]*id="tok"/.exec(nav)![1]!;
    const q = textOf(await client.callTool({ name: "browser_click", arguments: { ref: many, snapshot: false } }));
    // The list is capped (5 named) with the full count; the value and state changes are not part of any cap.
    expect(q).toMatch(/- 12 new interactive element\(s\): (\[e\d+\]<button>Remove filter \d+<\/button>( ; )?){5}\n/);
    expect(q).toContain(`value ${tok}: "" → "auto"`);
    expect(q).toMatch(new RegExp(`state: ${many} expanded: false → true`));
    expect(q).not.toContain("PAGE SNAPSHOT");
  }, 90_000);

  it("browser_find writes each hit as the screen writes that element: same ref and attributes, no candidate dropped (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/pick?find` } }));
    const screenLine = /(\[e\d+\]<a [^\n]*)Destination guide/.exec(nav)![1]!;
    const found = textOf(await client.callTool({ name: "browser_find", arguments: { query: "Destination guide, North Ridge" } }));
    // The guide link: the same ref and the same attributes as on the screen (the long query elided as the screen does).
    expect(found).toContain(`${screenLine}Destination guide`);
    expect(found).not.toContain("utm_campaign=winter-2026");
    // Every option the page has for "North Ridge" is still a hit (nothing capped away by the shorter lines).
    for (const label of ["North Ridge Westland", "North ridge Lakes (North Ridge), Westland", "North Ridge Inn"]) expect(found).toContain(label);
  }, 90_000);

  it("browser_wait with snapshot:false: the wait's note and evidence, no screen, never the printed base; the default is unchanged (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/waitq` } }));
    const ref = (name: string, t = nav) => new RegExp(`\\[(e\\d+)\\]<button[^\\n]*${name}`).exec(t)![1]!;
    await client.callTool({ name: "browser_click", arguments: { ref: ref("Load"), snapshot: false } });
    const quiet = textOf(await client.callTool({ name: "browser_wait", arguments: { seconds: 5, gone: "Totals pending", snapshot: false } }));
    expect(quiet).toMatch(/"Totals pending" is gone after \d+\.\d s/);
    expect(quiet).toContain('new text: "Total ₹4,321"');
    expect(quiet).toMatch(/1 new interactive element\(s\): \[e\d+\]<button>Details<\/button>/);
    expect(quiet).toContain("No page snapshot, as asked");
    expect(quiet).not.toContain("PAGE SNAPSHOT");
    // The next printed reply is against the navigate's screen (3 results back), never against the wait's capture.
    const flipped = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref("Flip") } }));
    expect(flipped).toMatch(/CHANGES ONLY since the page snapshot 3 browser results back/);
    expect(flipped).toContain("Total ₹4,321");
    expect(flipped).toContain("Side B");
    // Default (no snapshot): as before, a wait that saw a change prints the page.
    await client.callTool({ name: "browser_click", arguments: { ref: ref("Load"), snapshot: false } });
    const printed = textOf(await client.callTool({ name: "browser_wait", arguments: { seconds: 5, gone: "Totals pending" } }));
    expect(printed).toContain("PAGE SNAPSHOT");
    expect(printed).not.toContain("No page snapshot, as asked");
  }, 90_000);

  it("a quiet browser_wait across a move to another document says where it went; the next printed reply is whole; a page needing a person is still said (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/waitq?2` } }));
    const ref = (name: string) => new RegExp(`\\[(e\\d+)\\]<button[^\\n]*${name}`).exec(nav)![1]!;
    await client.callTool({ name: "browser_click", arguments: { ref: ref("Move"), snapshot: false } });
    const moved = textOf(await client.callTool({ name: "browser_wait", arguments: { seconds: 5, until: "Add filter", snapshot: false } }));
    expect(moved).toContain(`navigated: ${origin}/waitq?2 → ${origin}/quiet?moved`);
    expect(moved).toContain('title: "Totals" → "Filters"');
    expect(moved).not.toContain("PAGE SNAPSHOT");
    const next = textOf(await client.callTool({ name: "browser_scroll", arguments: { direction: "down" } }));
    expect(next).toContain("PAGE SNAPSHOT");
    expect(next).not.toContain("CHANGES ONLY");
    // A sign-in page reached during a quiet wait: still handed to the person.
    const nav2 = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/waitq?3` } }));
    await client.callTool({ name: "browser_click", arguments: { ref: new RegExp(`\\[(e\\d+)\\]<button[^\\n]*Sign in later`).exec(nav2)![1]!, snapshot: false } });
    const person = textOf(await client.callTool({ name: "browser_wait", arguments: { seconds: 5, until: "Sign in to your account", snapshot: false } }));
    expect(person).toMatch(/NEEDS A PERSON \(login/);
    expect(person).not.toContain("PAGE SNAPSHOT");
  }, 90_000);

  it("a shown address: the full href is recoverable, a page number or a site-used value shows applied, an unknown parameter shows not applied (17 Nov)", async () => {
    // What the tools give the model to follow the navigate wording; whether a model follows it is not testable here.
    const shown = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/shop?q=earbuds` } }));
    // The screen elides the long tracking query; browser_query gives every link's full href.
    expect(shown).toMatch(/Featured picks/);
    expect(shown).not.toContain("xpid=Mf1U2CCM_gaCS_long");
    const hrefs = JSON.parse(textOf(await client.callTool({ name: "browser_query", arguments: { expression: "[...document.links].map(a => a.href)" } }))) as string[];
    expect(hrefs.some((h) => h.endsWith("xpid=Mf1U2CCM_gaCS_long"))).toBe(true);
    const next = new URL(hrefs.find((h) => h.includes("page=2"))!);
    // Allowed: the site's own next-page address with its page number changed.
    next.searchParams.set("page", "3");
    const paged = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: next.href, snapshot: false } }));
    expect(paged).toContain(`navigated: ${next.href}`);
    expect(paged).toContain('page heading: "Results for "earbuds" — page 3, sorted by relevance, filters: none"');
    // Allowed: a sort and a filter value the site itself used in its links.
    const sorted = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: hrefs.find((h) => h.includes("sort=price-asc"))!, snapshot: false } }));
    expect(sorted).toContain("sorted by price, low to high");
    const filtered = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: hrefs.find((h) => h.includes("price=under-2000"))!, snapshot: false } }));
    expect(filtered).toContain("filters: under ₹2,000");
    // An opaque parameter this site does not use: it is ignored, and the evidence shows it was not applied.
    const invented = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/shop?q=earbuds&rh=p_36%3A-200000`, snapshot: false } }));
    expect(invented).toContain("filters: none");
    expect(invented).not.toContain("under ₹2,000");
  }, 90_000);

  // The verified-effect rule (17 Nov): what the tools show for each case it names. Whether a model follows the rule is
  // not testable here; these show the evidence it is told to check is there and tells the cases apart.
  const shopPrices = async () =>
    JSON.parse(textOf(await client.callTool({ name: "browser_query", arguments: { expression: "[...document.querySelectorAll('.item')].map(e => Number(e.textContent.split('₹')[1].replace(/,/g, '')))" } })).split("\n")[0]!) as number[];

  it("a quiet click whose new elements overflow the list names the new tabs it leaves out, and adds nothing else (17 Nov)", async () => {
    // An observation fix: the reply now shows the tabs; whether a model then opens one is not tested here.
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tabs` } }));
    const search = /\[(e\d+)\]<button[^\n]*Search/.exec(nav)![1]!;
    const out = textOf(await client.callTool({ name: "browser_click", arguments: { ref: search, snapshot: false } }));
    const listLine = out.split("\n").find((l) => l.includes("new interactive element(s)"))!;
    expect(listLine).toMatch(/^- 8 new interactive element\(s\): /);
    expect(listLine).not.toMatch(/role="tab"|<@?tab\b/);
    const tabsLine = out.split("\n").find((l) => l.includes("new tab(s) not listed above"))!;
    expect(tabsLine).toMatch(/^- 2 new tab\(s\) not listed above: .*Best.* ; .*Cheapest from ₹9,584/);
    expect(out.split("\n").indexOf(tabsLine)).toBe(out.split("\n").indexOf(listLine) + 1);
    // With the screen printed, the tabs are on it and there is no tabs line.
    await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tabs` } });
    const nav2 = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    const search2 = /\[(e\d+)\]<button[^\n]*Search/.exec(nav2)![1]!;
    const full = textOf(await client.callTool({ name: "browser_click", arguments: { ref: search2 } }));
    expect(full).toContain("Cheapest from ₹9,584");
    expect(full).not.toContain("new tab(s) not listed above");
  }, 90_000);

  // ---- Stage A1: a held ref after another held ref was re-grounded (17 Nov) ----
  const freshClient = async (secrets: McpConfig["secrets"] = {}) => {
    const own = createMcpServer({ config: { headless: true, allowedHosts: ["127.0.0.1"], allowPrivateNetwork: true, interventionTimeoutMs: 30_000, secrets, allowScreenshots: false } });
    return { own, c: await connect(own) };
  };
  const refOf = (page: string, label: string, nth = 0) => [...page.matchAll(new RegExp(`\\[(e\\d+)\\]<button[^\\n]*>${label}`, "g"))][nth]![1]!;
  const hitsOf = async (c: Client) => JSON.parse(textOf(await c.callTool({ name: "browser_query", arguments: { expression: "document.getElementById('hits').textContent" } })).split("\n")[0]!) as Record<string, number>;
  const regroundStart = async (c: Client, mode: string) => {
    const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/reground?mode=${mode}` } }));
    await new Promise((r) => setTimeout(r, 2_200)); // the page re-creates its buttons at 1.5 s, with no capture in between
    return nav;
  };

  it("A1: after one held ref is re-found, a second held ref still reaches its own element (quiet calls)", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = await regroundStart(c, "reorder");
      const a = refOf(nav, "Alpha");
      const b = refOf(nav, "Bravo");
      const first = await c.callTool({ name: "browser_click", arguments: { ref: a, snapshot: false } });
      const second = await c.callTool({ name: "browser_click", arguments: { ref: b, snapshot: false } });
      // The DOM first: which element each held ref reached (the page's own counter).
      expect(await hitsOf(c)).toEqual({ a: 1, b: 1 });
      expect(first.isError, textOf(first)).toBeFalsy();
      expect(second.isError, textOf(second)).toBeFalsy();
      expect(textOf(first)).toContain(`(${a} found again after the page redrew it`);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("A1: the same in one browser_actions batch", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = await regroundStart(c, "reorder");
      const out = await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: refOf(nav, "Alpha") }, { action: "click", ref: refOf(nav, "Bravo") }], snapshot: false } });
      expect(out.isError, textOf(out)).toBeFalsy();
      expect(await hitsOf(c)).toEqual({ a: 1, b: 1 });
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("A1 counterexamples: a removed target is stale (no repair by name); a same-name sibling keeps its place; a grown group is refused; refs from a page left behind are refused", async () => {
    const { own, c } = await freshClient();
    try {
      // Removed: Alpha is gone after the redraw; Bravo still counts on its own button.
      let nav = await regroundStart(c, "remove");
      const gone = await c.callTool({ name: "browser_click", arguments: { ref: refOf(nav, "Alpha"), snapshot: false } });
      expect(gone.isError).toBe(true);
      expect(textOf(gone)).toMatch(/stale/);
      await c.callTool({ name: "browser_click", arguments: { ref: refOf(nav, "Bravo"), snapshot: false } });
      expect(await hitsOf(c)).toEqual({ b: 1 });
      // Same name: the second Alpha is found again as the second Alpha.
      nav = await regroundStart(c, "same");
      await c.callTool({ name: "browser_click", arguments: { ref: refOf(nav, "Alpha", 1), snapshot: false } });
      await c.callTool({ name: "browser_click", arguments: { ref: refOf(nav, "Bravo"), snapshot: false } });
      expect(await hitsOf(c)).toEqual({ a2: 1, b: 1 });
      // A group of look-alikes that grew: refused rather than guessed.
      nav = await regroundStart(c, "group");
      const grown = await c.callTool({ name: "browser_click", arguments: { ref: refOf(nav, "Alpha", 1), snapshot: false } });
      expect(grown.isError).toBe(true);
      expect(await hitsOf(c)).toEqual({});
      // A ref from a page the tab has left: no element of the new page is clicked.
      nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/reground?mode=reorder` } }));
      const held = refOf(nav, "Bravo");
      await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/spa`, snapshot: false } });
      const left = await c.callTool({ name: "browser_click", arguments: { ref: held, snapshot: false } });
      expect(left.isError).toBe(true);
    } finally {
      await c.close();
      await own.close();
    }
  }, 120_000);

  // ---- Stage B ----
  for (const mode of ["dialog", "tab", "write"] as const) {
    it(`B1: a batch stops after a step that ${mode === "dialog" ? "raised a dialog" : mode === "tab" ? "opened a new tab" : "had a write refused"}; step 3 is not run; step 1's facts stay`, async () => {
      const { own, c } = await freshClient();
      try {
        const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/batch?mode=${mode}` } }));
        const size = /\[(e\d+)\]<select[^\n]*Size/.exec(nav)![1]!;
        const two = /\[(e\d+)\]<button[^\n]*>Two/.exec(nav)![1]!;
        const three = /\[(e\d+)\]<button[^\n]*>Three/.exec(nav)![1]!;
        const out = textOf(await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "select", ref: size, values: ["Large"] }, { action: "click", ref: two }, { action: "click", ref: three }], snapshot: false } }));
        // Step 1's fact under its line; the stop said, with the steps not run.
        expect(out).toMatch(new RegExp(`^1\\. [^\\n]*\\n   Selected: Large\\n   - field ${size}: selected "Large"\\.`, "m"));
        const why = mode === "dialog" ? "it raised a dialog" : mode === "tab" ? "it opened a new tab" : "the server did not accept or answer a write";
        expect(out).toContain(`Stopped after step 2: ${why}`);
        expect(out).toContain("steps 3-3 were not run");
        // Step 3 did not run: the page's own counter (back in the first tab for the tab case).
        if (mode === "tab") await c.callTool({ name: "browser_tabs", arguments: { switch_to: "t1" } });
        const hits = JSON.parse(textOf(await c.callTool({ name: "browser_query", arguments: { expression: "document.getElementById('hits').textContent" } })).split("\n")[0]!);
        expect(hits).toEqual({ s2: 1 });
      } finally {
        await c.close();
        await own.close();
      }
    }, 90_000);
  }

  it("B2/B3: what a field holds after type or select, said against what was typed; secrets and passwords never shown; replaced fields unknown", async () => {
    // A server of its own, with the broker secret: the shared session's secret guard counts earlier tests' typing.
    const { own, c: client } = await freshClient({ pw: { value: SECRET } });
    try {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/fields` } }));
    const field = (label: string) => new RegExp(`\\[(e\\d+)\\]<[^\\n]*(?:aria-label|label)="${label}"`).exec(nav)?.[1] ?? new RegExp(`\\[(e\\d+)\\][^\\n]*${label}`).exec(nav)![1]!;
    const type = async (label: string, t: string) => textOf(await client.callTool({ name: "browser_type", arguments: { ref: field(label), text: t, snapshot: false } }));
    const plain = await type("Plain", "hello");
    expect(plain).toContain(`- field ${field("Plain")}: holds what was typed.`);
    expect(plain).toContain("(Field state only: not proof the site accepted it.)");
    const pw = await type("Password", "opensesame");
    expect(pw).toContain("holds what was typed (value not shown)");
    expect(pw).not.toContain("opensesame");
    const secret = await type("Echo", "{{pw}}");
    expect(secret).toContain("(value not shown)");
    expect(secret).toMatch(/- validation e\d+: invalid/);
    expect(secret).not.toContain(SECRET);
    const swapped = await type("Swapped", "x");
    expect(swapped).toContain("replaced or removed by the page after the action; not read back (unknown)");
    const reset = await type("Reset", "gone");
    expect(reset).toContain('now "" (empty), not what was typed ("gone")');
    const short = await type("Short", "abcdef");
    expect(short).toContain('now "abc", not what was typed ("abcdef")');
    const phone = await type("Phone", "1234567");
    expect(phone).toContain('now "(123) 4567", not what was typed ("1234567")');
    const email = await type("Email", "nobody");
    expect(email).toMatch(/- validation e\d+: invalid \("[^"]*@/);
    const code = await type("Code", "12");
    expect(code).toMatch(/- validation e\d+: invalid\./);
    const extras = textOf(await client.callTool({ name: "browser_select", arguments: { ref: field("Extras"), values: ["Bag", "Seat"], snapshot: false } }));
    expect(extras).toContain(`- field ${field("Extras")}: selected "Bag", "Seat".`);
    const note = await type("Note", "call me");
    expect(note).toContain(`- field ${field("Note")}: holds what was typed.`);
    } finally {
      await client.close();
      await own.close();
    }
  }, 120_000);

  // ---- Stage C ----
  it("C1: expectations say MATCHED, UNMET, ALREADY HELD or AMBIGUOUS (why); counted places; a frame scope; an expected navigation; nothing without opting in", async () => {
    const { own, c } = await freshClient();
    try {
      const open = async () => textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/expect` } }));
      let nav = await open();
      const ref = (re: RegExp, t = nav) => re.exec(t)![1]!;
      // Snapshot lines only (an evidence line can list several elements, so a match there would take the wrong ref).
      const btn = (label: string, t = nav) => ref(new RegExp(`^\\t*\\*?\\[((?:f\\d+)?e\\d+)\\]<button[^\\n]*>${label}`, "m"), t);
      const click = async (r: string, expect?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        textOf(await c.callTool({ name: "browser_click", arguments: { ref: r, snapshot: false, ...(expect ? { expect } : {}), ...extra } }));
      // Matched after the page's own delay, scoped to the button whose label changes.
      const add = btn("Add");
      expect(await click(add, { text: "Added to cart", in: add })).toContain(`- expect: MATCHED — "Added to cart" shown in ${add}.`);
      // Unmet.
      expect(await click(btn("Noop"), { text: "Never shown", within: 0.5 })).toContain('- expect: UNMET — "Never shown" not shown.');
      // Already held: true before the click too (a state, not the click's doing).
      expect(await click(btn("Noop"), { text: "Empty" })).toContain('- expect: ALREADY HELD before the action — "Empty" shown.');
      // Several places: matched and counted.
      expect(await click(btn("Dup"), { text: "Saved" })).toContain('- expect: MATCHED — "Saved" shown (2 occurrences of the text).');
      // A scope that is no element on the page: ambiguous, said why.
      expect(await click(btn("Noop"), { text: "x", in: "e999" })).toContain("- expect: AMBIGUOUS — e999 is not an element on the page (0 matches).");
      // A scope the action replaced: ambiguous.
      const box = ref(/\|SCROLL\|\[(e\d+)\]/);
      const swapped = await click(btn("Swap"), { text: "Line one", in: box });
      expect(swapped).toContain(`- expect: AMBIGUOUS — ${box} was replaced or removed.`);
      // A scope inside a same-origin frame.
      nav = await open();
      const inner = btn("Inner");
      // The frame's button changed from the main page (a click inside the frame is not what this checks).
      expect(await click(btn("Ping"), { text: "Done here", in: inner })).toContain(`- expect: MATCHED — "Done here" shown in ${inner}.`);
      // A scope in a frame that the action removes: ambiguous, never matched or unmet.
      const vanish = btn("Vanish");
      expect(await click(vanish, { text: "Vanish", in: vanish })).toMatch(/- expect: AMBIGUOUS — e\d+ (was replaced or removed|'s frame is gone)\./);
      // An expected navigation: the address is checked on the new document.
      const go = ref(/\[(e\d+)\]<a[^\n]*>Go/);
      const went = await click(go, { url: "/spa" });
      expect(went).toContain('- expect: MATCHED — address contains "/spa". The page loaded another document; this was checked on it.');
      // Nothing without opting in.
      nav = await open();
      expect(await click(btn("Noop"))).not.toContain("- expect:");
    } finally {
      await c.close();
      await own.close();
    }
  }, 120_000);

  it("C2/C3: a scoped wait says when it already held; escalate prints the page on a dialog, and only when asked", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/expect` } }));
      const btn = (label: string) => new RegExp(`^\\t*\\*?\\[(e\\d+)\\]<button[^\\n]*>${label}`, "m").exec(nav)![1]!;
      const add = btn("Add");
      await c.callTool({ name: "browser_click", arguments: { ref: add, snapshot: false } });
      const waited = textOf(await c.callTool({ name: "browser_wait", arguments: { seconds: 3, until: "Added to cart", in: add, snapshot: false } }));
      expect(waited).toMatch(/expect: MATCHED — "Added to cart" shown in e\d+/);
      const again = textOf(await c.callTool({ name: "browser_wait", arguments: { seconds: 1, until: "Added to cart", in: add, snapshot: false } }));
      expect(again).toContain("ALREADY HELD before the action");
      // Escalation: an alert with snapshot:false prints the page only when escalate is asked.
      const quiet = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn("Warn"), snapshot: false } }));
      expect(quiet).toContain('dialog "Heads up" was auto-accepted');
      expect(quiet).not.toContain("PAGE SNAPSHOT");
      const loud = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn("Warn"), snapshot: false, escalate: true } }));
      expect(loud).toContain("PAGE SNAPSHOT");
      expect(loud).toContain("(Printed whole although snapshot:false was asked");
      // Escalation stays quiet when nothing calls for a look.
      const calm = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn("Noop"), snapshot: false, escalate: true, expect: { text: "Empty" } } }));
      expect(calm).not.toContain("PAGE SNAPSHOT");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  // ---- Review findings (R1-R7) ----
  const snapLine = (t: string, label: string) => new RegExp(`^\\t*\\*?\\[(e\\d+)\\]<button[^\\n]*>${label}`, "m").exec(t)![1]!;

  it("R1: escalation prints a real page when nothing changed (unmet expectation) and when only a write failed", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review` } }));
      const still = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Still"), snapshot: false, escalate: true, expect: { text: "Never shown", within: 0.3 } } }));
      expect(still).toContain("UNMET");
      expect(still).toMatch(/PAGE SNAPSHOT \(/);
      expect(still).toMatch(/^\t*\[e\d+\]<button[^\n]*>Ping server/m);
      expect(still).not.toContain("the same as the page snapshot");
      const sent = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Ping server"), snapshot: false, escalate: true } }));
      expect(sent).toContain("the server did NOT accept this");
      expect(sent).toMatch(/PAGE SNAPSHOT \(/);
      expect(sent).toMatch(/^\t*\[e\d+\]<button[^\n]*>Still/m);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("R2: a typed password echoed by the page's validation message is never printed, even if the field stops being a password", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review` } }));
      const pin = /\[(e\d+)\]<input[^\n]*Pin/.exec(nav)![1]!;
      const typed = textOf(await c.callTool({ name: "browser_type", arguments: { ref: pin, text: "s3cretPIN", snapshot: false } }));
      expect(typed).not.toContain("s3cretPIN");
      const batch = textOf(await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "type", ref: pin, text: "0therPIN" }, { action: "click", ref: snapLine(nav, "Still") }], snapshot: false } }));
      expect(batch).not.toContain("0therPIN");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("R3: an expectation met after the settle is judged on the page the reply's evidence describes", async () => {
    const { own, c } = await freshClient();
    try {
      let nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review` } }));
      const quiet = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Late"), snapshot: false, expect: { text: "Arrived late", within: 3 } } }));
      expect(quiet).toContain('- expect: MATCHED — "Arrived late" shown');
      expect(quiet).toMatch(/- new text: [^\n]*"Arrived late"/);
      nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review` } }));
      const shown = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Late"), expect: { text: "Arrived late", within: 3 } } }));
      expect(shown).toContain('- expect: MATCHED — "Arrived late" shown');
      expect(shown.slice(shown.indexOf("PAGE SNAPSHOT"))).toContain("Arrived late");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("R3b: a control added after the settle is in the returned evidence or page, and its ref acts on it (normal, quiet+escalate)", async () => {
    const { own, c } = await freshClient();
    try {
      const lateHits = async () => textOf(await c.callTool({ name: "browser_query", arguments: { expression: "document.getElementById('late-hits').textContent" } })).split("\n")[0];
      // Normal: the printed page carries the new control with its ref.
      let nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review` } }));
      const shown = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Late control"), expect: { text: "Show details", within: 3 } } }));
      expect(shown).toContain('- expect: MATCHED — "Show details" shown');
      const fromPage = new RegExp("\\[(e\\d+)\\]<button[^\\n]*>Show details").exec(shown.slice(shown.indexOf("PAGE SNAPSHOT")))?.[1];
      expect(fromPage, shown).toBeTruthy();
      await c.callTool({ name: "browser_click", arguments: { ref: fromPage!, snapshot: false } });
      expect(await lateHits()).toBe("1");
      // Quiet + escalate: matched, so no page; the evidence lists the new control with its ref, and the ref works.
      nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review` } }));
      const quiet = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Late control"), snapshot: false, escalate: true, expect: { text: "Show details", within: 3 } } }));
      expect(quiet).toContain('- expect: MATCHED — "Show details" shown');
      expect(quiet).not.toContain("PAGE SNAPSHOT");
      const fromEvidence = /new interactive element\(s\): [^\n]*\[(e\d+)\]<button>Show details/.exec(quiet)?.[1];
      expect(fromEvidence, quiet).toBeTruthy();
      await c.callTool({ name: "browser_click", arguments: { ref: fromEvidence!, snapshot: false } });
      expect(await lateHits()).toBe("1");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  // ---- Second review: A (secrecy across calls), B (value-level scrub), C (events while polled) ----
  const fieldRef = (t: string, label: string) => new RegExp(`\\[(e\\d+)\\]<input[^\\n]*${label}`).exec(t)![1]!;

  it("A: a password the page turns into text stays hidden in later reads, the next action and a batch's final page", async () => {
    const { own, c } = await freshClient();
    const SECRET_A = "Zq9longSecret";
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/secret` } }));
      const typed = textOf(await c.callTool({ name: "browser_type", arguments: { ref: fieldRef(nav, "Code"), text: SECRET_A, snapshot: false } }));
      const outs: Record<string, string> = { typed };
      outs["snapshot"] = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      outs["query"] = textOf(await c.callTool({ name: "browser_query", arguments: { expression: "[...document.querySelectorAll('input')].map(e => e.value)" } }));
      outs["get_text"] = textOf(await c.callTool({ name: "browser_get_text", arguments: {} }));
      const next = snapLine(outs["snapshot"], "Next step");
      outs["next"] = textOf(await c.callTool({ name: "browser_click", arguments: { ref: next } }));
      outs["batch"] = textOf(await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: next }] } }));
      for (const [k, v] of Object.entries(outs)) expect(v.includes(SECRET_A), k).toBe(false);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("A: a short password (2 characters) is not shown as the field's value later", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/secret` } }));
      await c.callTool({ name: "browser_type", arguments: { ref: fieldRef(nav, "Pin2"), text: "ab", snapshot: false } });
      const snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      expect(snap).not.toMatch(/value="ab"/);
      const q = textOf(await c.callTool({ name: "browser_query", arguments: { expression: "document.querySelector('[aria-label=Pin2]').value" } }));
      expect(q.split("\n")[0]).not.toBe("ab");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("B: a password with JSON-significant characters neither breaks the reply nor shows, in any form", async () => {
    const { own, c } = await freshClient();
    const SECRET_B = 'x":"y\\z';
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/secret` } }));
      const r = await c.callTool({ name: "browser_type", arguments: { ref: fieldRef(nav, "Quote"), text: SECRET_B, snapshot: false } });
      expect(r.isError, textOf(r)).toBeFalsy();
      const outs = [textOf(r), textOf(await c.callTool({ name: "browser_snapshot", arguments: {} })), textOf(await c.callTool({ name: "browser_query", arguments: { expression: "document.querySelector('[aria-label=Quote]').value" } }))];
      for (const v of outs) {
        expect(v).not.toContain(SECRET_B);
        expect(v).not.toContain(JSON.stringify(SECRET_B).slice(1, -1));
      }
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C: events while an expectation is polled (a dialog, a refused write, a still-loading page, another document) are all in the receipt's reply", async () => {
    const { own, c } = await freshClient();
    try {
      let nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/late` } }));
      const events = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Late events"), snapshot: false, expect: { text: "Done later", within: 4 } } }));
      expect(events).toContain('- expect: MATCHED — "Done later" shown');
      expect(events).toContain('alert dialog "Late alert" was auto-accepted');
      expect(events).toContain("the server did NOT accept this");
      // Still loading after the poll: said, and with escalate the page is printed.
      nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/late` } }));
      const busy = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Late busy"), snapshot: false, escalate: true, expect: { text: "Busy shown", within: 4 } } }));
      expect(busy).toContain('- expect: MATCHED — "Busy shown" shown');
      expect(busy).toMatch(/Loading results/);
      expect(busy).toContain("PAGE SNAPSHOT");
      // Another document while polled: the evidence says so, and its refs act on the new page.
      nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/late` } }));
      const went = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Late go"), snapshot: false, escalate: true, expect: { text: "Waiting", within: 4 } } }));
      expect(went).toContain('- expect: MATCHED — "Waiting" shown');
      expect(went).toMatch(/navigated: [^\n]*\/scope1/);
      const nextRef = /\[(e\d+)\]<a[^\n]*>Next/.exec(went.slice(went.indexOf("PAGE SNAPSHOT")))?.[1];
      expect(nextRef, went).toBeTruthy();
      const onward = textOf(await c.callTool({ name: "browser_click", arguments: { ref: nextRef!, snapshot: false } }));
      expect(onward).toMatch(/navigated: [^\n]*\/scope2/);
    } finally {
      await c.close();
      await own.close();
    }
  }, 120_000);

  for (const [label, value] of [["one character", "q"], ["two characters with a URL-encoded form", "z&"]] as const) {
    it(`short password (${label}) echoed with a prefix into status, heading, title, address and validation: never shown in any later output`, async () => {
      const { own, c } = await freshClient();
      try {
        const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/echo` } }));
        const outs: Record<string, string> = {};
        outs["typed"] = textOf(await c.callTool({ name: "browser_type", arguments: { ref: fieldRef(nav, "Pin"), text: value, snapshot: false } }));
        outs["snapshot"] = textOf(await c.callTool({ name: "browser_snapshot", arguments: { whole_page: true } }));
        outs["get_text"] = textOf(await c.callTool({ name: "browser_get_text", arguments: {} }));
        outs["find"] = textOf(await c.callTool({ name: "browser_find", arguments: { query: "Pin set, Hello" } }));
        outs["query"] = textOf(await c.callTool({ name: "browser_query", arguments: { expression: "[document.title, location.href, document.getElementById('st').textContent, document.querySelector('h2').textContent, document.querySelector('input').validationMessage]" } }));
        // By the button's position in the first page (its ref may be redacted in later text).
        // The next step only from what is emitted now: the latest snapshot's own ref if it was shown, else a refusal.
        const next = outs["snapshot"]!.startsWith("UNSAFE_OUTPUT") ? undefined : /\[(e\d+)\]<button/.exec(outs["snapshot"]!)?.[1];
        if (!next) expect(outs["snapshot"]).toMatch(/^UNSAFE_OUTPUT/);
        if (next) {
          outs["next"] = textOf(await c.callTool({ name: "browser_click", arguments: { ref: next } }));
          outs["batch"] = textOf(await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: next }] } }));
        }
        const forms = [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
        // Plain substring absence, independent of how the implementation matches.
        for (const [k, v] of Object.entries(outs)) for (const f of forms) expect(v.includes(f), `${k} contains ${JSON.stringify(f)}:\n${v.slice(0, 1500)}`).toBe(false);
      } finally {
        await c.close();
        await own.close();
      }
    }, 120_000);
  }

  for (const [label, value] of [["one character", "q"], ["two characters", "z&"]] as const) {
    it(`short password (${label}) echoed glued to other characters, and in base64: no form of it in any later output`, async () => {
      const { own, c } = await freshClient();
      try {
        const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/glue` } }));
        const outs: Record<string, string> = {};
        outs["typed"] = textOf(await c.callTool({ name: "browser_type", arguments: { ref: fieldRef(nav, "Pin"), text: value, snapshot: false } }));
        outs["snapshot"] = textOf(await c.callTool({ name: "browser_snapshot", arguments: { whole_page: true } }));
        outs["get_text"] = textOf(await c.callTool({ name: "browser_get_text", arguments: {} }));
        outs["find"] = textOf(await c.callTool({ name: "browser_find", arguments: { query: "Pin, B64" } }));
        outs["query"] = textOf(await c.callTool({ name: "browser_query", arguments: { expression: "[document.title, location.href, document.getElementById('st').textContent, document.getElementById('b64').textContent, document.querySelector('h2').textContent, document.querySelector('input').validationMessage]" } }));
        // The next action and a batch: by the button's position (its ref may itself be redacted in the printed text).
        // The next step only from what is emitted now: the latest snapshot's own ref if it was shown, else a refusal.
        const next = outs["snapshot"]!.startsWith("UNSAFE_OUTPUT") ? undefined : /\[(e\d+)\]<button/.exec(outs["snapshot"]!)?.[1];
        if (!next) expect(outs["snapshot"]).toMatch(/^UNSAFE_OUTPUT/);
        if (next) {
          outs["next"] = textOf(await c.callTool({ name: "browser_click", arguments: { ref: next } }));
          outs["batch"] = textOf(await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: next }] } }));
        }
        const forms = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64"), Buffer.from(value).toString("base64url")]);
        for (const [k, v] of Object.entries(outs)) for (const f of forms) expect(v.includes(f), `${k} contains ${JSON.stringify(f)}:\n${v.slice(0, 1200)}`).toBe(false);
      } finally {
        await c.close();
        await own.close();
      }
    }, 120_000);
  }

  // ---- Fifth review: fail-closed output ----
  const REF = /\[(?:f\d+)?e\d+\]/;
  const isUnsafe = (r: unknown) => (r as { isError?: unknown }).isError === true && textOf(r as Parameters<typeof textOf>[0]).startsWith("UNSAFE_OUTPUT");

  it("continuation after a one-character password that collides with the ref grammar: only an honest current ref and a correct click, or an explicit unsafe-output refusal", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/collide` } }));
      const pin = /\[(e\d+)\]<input[^\n]*Pin/.exec(nav)![1]!;
      const typed = await c.callTool({ name: "browser_type", arguments: { ref: pin, text: "e", snapshot: false } });
      // The next step may come only from what is emitted now.
      const state = await c.callTool({ name: "browser_snapshot", arguments: {} });
      for (const r of [typed, state]) {
        const t = textOf(r);
        if (isUnsafe(r)) {
          // Refused: no page text, no refs, and it says what happened to the action.
          expect(t, t).not.toMatch(REF);
          expect(t).not.toContain("Continue");
          expect(t).not.toContain("Collide");
        } else {
          // Shown: every ref printed is whole (no redaction inside the grammar), and the secret is not echoed.
          expect(t, t).not.toContain("•");
        }
      }
      if (isUnsafe(typed)) expect(textOf(typed)).toMatch(/The type was dispatched/);
      if (!isUnsafe(state)) {
        const go = /\[(e\d+)\]<button[^\n]*>Continue/.exec(textOf(state))?.[1];
        expect(go, textOf(state)).toBeTruthy();
        await c.callTool({ name: "browser_click", arguments: { ref: go!, snapshot: false } });
        const hits = textOf(await c.callTool({ name: "browser_query", arguments: { expression: "document.getElementById('hits').textContent" } }));
        expect(hits.split("\n")[0]).toBe("1");
      }
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("a schema-constrained read of a value holding a short typed password never reports success with an altered or out-of-schema value", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/collide` } }));
      const short = /\[(e\d+)\]<input[^\n]*Short/.exec(nav)![1]!;
      await c.callTool({ name: "browser_type", arguments: { ref: short, text: "q", snapshot: false } });
      const r = await c.callTool({ name: "browser_query", arguments: { expression: "document.getElementById('glued').textContent", schema: { type: "string", maxLength: 3 } } });
      const t = textOf(r);
      // The page's value ("A" + secret + "B") in no form; the server's own wording may hold the letter.
      for (const f of ["AqB", "Aq", "qB"]) expect(t).not.toContain(f);
      if (!r.isError) {
        // A success must carry the page's real value (it cannot: the value holds the password), so success is wrong here.
        expect.fail(`reported success: ${t} ${JSON.stringify((r as { structuredContent?: unknown }).structuredContent)}`);
      }
      // Withheld before validation (a mismatch here would come from the redaction, not from the page's value).
      expect(isUnsafe(r), t).toBe(true);
      expect((r as { structuredContent?: unknown }).structuredContent).toBeUndefined();
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  // ---- Sixth review: the change-list base, screenshots, and what a withheld reply says ----
  const SECRET6 = "Zq7xK";
  const formsOf = (v: string) => [v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url")];

  it("sixth review: a withheld reply never becomes the base of a later change list; a later shown page is whole or against a page that was delivered", async () => {
    const { own, c } = await freshClient();
    try {
      const replies: { unsafe: boolean; text: string }[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await c.callTool({ name, arguments: args });
        replies.push({ unsafe: isUnsafe(r), text: textOf(r) });
        return r;
      };
      const nav = textOf(await call("browser_navigate", { url: `${origin}/base` }));
      const code = /\[(e\d+)\]<input[^\n]*Code/.exec(nav)![1]!;
      const typed = await call("browser_type", { ref: code, text: SECRET6 });
      expect(isUnsafe(typed), textOf(typed)).toBe(true); // the page shows the value: withheld
      await new Promise((r) => setTimeout(r, 2_000)); // the page removes the value by itself
      await call("browser_wait", { seconds: 0.5 });
      const last = await call("browser_wait", { seconds: 0.5 });
      const log = replies.map((r, i) => `#${i} ${r.unsafe ? "WITHHELD" : "shown"}: ${r.text.slice(0, 300)}`).join("\n---\n");
      // Once the value is gone from the page, a reply is shown again.
      expect(isUnsafe(last), log).toBe(false);
      for (const [i, r] of replies.entries()) {
        if (r.unsafe) continue;
        for (const f of formsOf(SECRET6)) expect(r.text, `reply ${i} shows ${f}`).not.toContain(f);
        // A change list or "the same as" may only point back to a reply the client was given.
        const back = /(?:CHANGES ONLY since|the same as) the page snapshot (\d+) browser results? back/.exec(r.text);
        if (back) expect(replies[i - Number(back[1])]?.unsafe, `reply ${i} is relative to reply ${i - Number(back[1])}, which was withheld:\n${log}`).toBe(false);
      }
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("sixth review: after a withheld reply, an action that changes nothing never says refs from that unseen snapshot are still valid", async () => {
    const { own, c } = await freshClient();
    try {
      const replies: { unsafe: boolean; text: string }[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await c.callTool({ name, arguments: args });
        replies.push({ unsafe: isUnsafe(r), text: textOf(r) });
        return r;
      };
      const nav = textOf(await call("browser_navigate", { url: `${origin}/base?stay=1` }));
      const code = /\[(e\d+)\]<input[^\n]*Code/.exec(nav)![1]!;
      const typed = await call("browser_type", { ref: code, text: SECRET6 });
      expect(isUnsafe(typed), textOf(typed)).toBe(true); // the page shows the value: withheld
      // Nothing changes on the page now; the value stays shown.
      await call("browser_wait", { seconds: 0.5 });
      await call("browser_scroll", { direction: "up" });
      await call("browser_wait", { seconds: 0.5, snapshot: false });
      const log = replies.map((r, i) => `#${i} ${r.unsafe ? "WITHHELD" : "shown"}: ${r.text.slice(0, 400)}`).join("\n---\n");
      for (const [i, r] of replies.entries()) {
        if (r.unsafe || i === 0) continue;
        for (const f of formsOf(SECRET6)) expect(r.text, `reply ${i} shows ${f}`).not.toContain(f);
        // "Unchanged / refs still valid" is relative to the last page printed: never one that was withheld.
        if (/refs from the previous snapshot are still valid/.test(r.text)) {
          const prev = replies.slice(0, i).reverse().find((p) => p.unsafe || /PAGE SNAPSHOT/.test(p.text));
          expect(prev?.unsafe, `reply ${i} vouches for the refs of a withheld snapshot:\n${log}`).toBe(false);
        }
        const back = /(?:CHANGES ONLY since|the same as) the page snapshot (\d+) browser results? back/.exec(r.text);
        if (back) expect(replies[i - Number(back[1])]?.unsafe, `reply ${i} is relative to a withheld reply:\n${log}`).toBe(false);
      }
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("sixth review: after a password is typed into a password field, browser_screenshot is withheld (pixels cannot be checked); before that, it is given", async () => {
    const own = createMcpServer({ config: { headless: true, allowedHosts: ["127.0.0.1"], allowPrivateNetwork: true, interventionTimeoutMs: 30_000, secrets: {}, allowScreenshots: true } });
    const c = await connect(own);
    const hasImage = (r: unknown) => ((r as { content: { type: string }[] }).content ?? []).some((x) => x.type === "image");
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/base` } }));
      const before = await c.callTool({ name: "browser_screenshot", arguments: {} });
      expect(hasImage(before), textOf(before)).toBe(true);
      const code = /\[(e\d+)\]<input[^\n]*Code/.exec(nav)![1]!;
      await c.callTool({ name: "browser_type", arguments: { ref: code, text: SECRET6, snapshot: false } });
      await new Promise((r) => setTimeout(r, 2_000)); // the page's echo is gone; the field still holds the value
      const after = await c.callTool({ name: "browser_screenshot", arguments: {} });
      expect(hasImage(after), textOf(after)).toBe(false);
      expect(isUnsafe(after), textOf(after)).toBe(true);
      for (const f of formsOf(SECRET6)) expect(JSON.stringify(after)).not.toContain(f);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("sixth review: a withheld reply says the action was dispatched, not that it succeeded, claims no failed batch step, and warns against a blind repeat", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/base` } }));
      const typed = await c.callTool({ name: "browser_type", arguments: { ref: /\[(e\d+)\]<input[^\n]*Code/.exec(nav)![1]!, text: SECRET6 } });
      const t = textOf(typed);
      expect(isUnsafe(typed), t).toBe(true);
      expect(t).toMatch(/dispatched/);
      expect(t).toMatch(/outcome[^.]*not known/);
      expect(t).toMatch(/[Dd]o not repeat/);
      expect(t).not.toMatch(/\b(ran|succeeded|worked)\b/);
      // A batch on a fresh copy of the page (the value is gone from it, so its first reply is shown).
      const nav2 = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/base?b=1` } }));
      expect(nav2).toContain("Echo none");
      const batch = await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "type", ref: /\[(e\d+)\]<input[^\n]*Code/.exec(nav2)![1]!, text: SECRET6 }] } });
      const b = textOf(batch);
      expect(isUnsafe(batch), b).toBe(true);
      expect(b).not.toMatch(/stopped at a step that failed/);
      expect(b).toMatch(/dispatched/);
      expect(b).toMatch(/[Dd]o not repeat/);
      for (const f of formsOf(SECRET6)) expect(b + t).not.toContain(f);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  // ---- Seventh review (lane-cred) ----
  it("seventh review: a batch that moves to an address holding a configured secret never prints that address raw", async () => {
    const { own, c } = await freshClient({ pw: { value: SECRET } });
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/moveto` } }));
      await c.callTool({ name: "browser_type", arguments: { ref: /\[(e\d+)\]<input[^\n]*Token/.exec(nav)![1]!, text: "{{pw}}", snapshot: false } });
      const batch = textOf(await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: refOf(nav, "Go") }, { action: "click", ref: refOf(nav, "Other") }], snapshot: false } }));
      // 18 Nov: the reply would show the address that holds the secret, so it is withheld whole (dispatched, no repeat).
      expect(batch, batch).toMatch(/^UNSAFE_OUTPUT[^\n]*dispatched/);
      // Independent proof of the move and of the value typed: what the fixture server received.
      expect(received).toContain(`/landing?k=${encodeURIComponent(SECRET)}`);
      expect(batch, batch).not.toContain(SECRET);
      expect(batch, batch).not.toContain(encodeURIComponent(SECRET));
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  // ---- Output-guard tightening (18 Nov). Every case: a control with no secret value in the output (given, so
  // over-withholding shows); every withheld reply with independent proof that the action was dispatched with the
  // right value (what the fixture server received, never read through the MCP); after a withheld reply, the next
  // page is shown whole and a ref from it works, or the next assertion uses a fresh browser. ----
  const allForms = (v: string) => [...new Set([v, encodeURIComponent(v), encodeURI(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url")])].filter(Boolean);
  /** The reply is withheld whole: UNSAFE_OUTPUT, an error, no ref, no structured content. */
  const withheldWhole = (r: unknown) => {
    const t = textOf(r as Parameters<typeof textOf>[0]);
    expect(isUnsafe(r), t).toBe(true);
    expect(t, t).not.toMatch(/\[(?:f\d+)?e\d+\]/);
    expect((r as { structuredContent?: unknown }).structuredContent).toBeUndefined();
  };
  /** The reply is given (a control): not UNSAFE_OUTPUT, and it shows `shows`. */
  const givenWith = (r: unknown, shows: string) => {
    const t = textOf(r as Parameters<typeof textOf>[0]);
    expect(isUnsafe(r), t).toBe(false);
    expect(t, t).toContain(shows);
  };
  const navTight = async (c: Client, form: string, tag = "") => textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tight?form=${form}${tag ? `&t=${tag}` : ""}` } }));
  const fieldOf = (nav: string, label: string) => new RegExp(`\\[(e\\d+)\\]<input[^\\n]*${label}`).exec(nav)![1]!;
  const nextRef = (page: string) => /\[(e\d+)\]<button[^\n]*>Next/.exec(page)![1]!;
  const typeInto = (c: Client, ref: string, text: string, snapshot = true) => c.callTool({ name: "browser_type", arguments: { ref, text, ...(snapshot ? {} : { snapshot: false }) } });
  /** What the fixture page sent the fixture server for a field (its own beacon), after it arrives. */
  const beaconed = async (field: string, tag: string, value: string) => {
    const want = `/tight-log?f=${field}&t=${tag}&v=${Array.from(value).map((ch) => ch.codePointAt(0)).join(".")}`;
    for (let i = 0; i < 40 && !received.includes(want); i++) await new Promise((r) => setTimeout(r, 50));
    expect(received, want).toContain(want);
  };
  /** The reference contract after a withheld reply: a fresh page is printed whole, and a ref from it acts. */
  const wholeAgainAndActs = async (c: Client, tag: string) => {
    const page = await navTight(c, "raw", tag);
    expect(page.startsWith("UNSAFE_OUTPUT"), page).toBe(false);
    expect(page).toContain("PAGE SNAPSHOT");
    expect(page).not.toMatch(/CHANGES ONLY since|the same as the page snapshot/);
    await c.callTool({ name: "browser_click", arguments: { ref: nextRef(page), snapshot: false } });
    await beaconed("next", tag, "");
  };

  it("tightening: a reserved-character password echoed only through encodeURI is withheld whole, in no form; dispatched with that value; the next page is whole and acts (control: a plain value is given)", async () => {
    const { own, c } = await freshClient();
    const v = "p@ss/w%rd&x?#";
    const tag = `uri${Date.now()}`;
    try {
      const nav = await navTight(c, "uri", tag);
      givenWith(await typeInto(c, fieldOf(nav, "Note"), "plain-note"), "Echo plain-note");
      const typed = await typeInto(c, fieldOf(nav, "Pass"), v);
      withheldWhole(typed);
      await beaconed("pass", tag, v);
      for (const f of allForms(v)) expect(textOf(typed)).not.toContain(f);
      await wholeAgainAndActs(c, `${tag}b`);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: a 2-character configured secret typed by placeholder into a plain field and echoed is withheld whole; dispatched with that value (control: another value in that field is given)", async () => {
    const { own, c } = await freshClient({ pin: { value: "Zx" } });
    const tag = `short${Date.now()}`;
    try {
      const nav = await navTight(c, "raw", tag);
      givenWith(await typeInto(c, fieldOf(nav, "Note"), "hello"), "Echo hello");
      const typed = await typeInto(c, fieldOf(nav, "Note"), "{{pin}}");
      withheldWhole(typed);
      await beaconed("note", tag, "Zx");
      expect(textOf(typed)).not.toContain("Zx");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: a configured secret typed by placeholder into a field the page does not echo: later replies are given, the field showing no value (over-withholding control); dispatched with that value", async () => {
    const { own, c } = await freshClient({ pw: { value: SECRET } });
    const tag = `quiet${Date.now()}`;
    try {
      const nav = await navTight(c, "none", tag);
      const typed = await typeInto(c, fieldOf(nav, "Note"), "{{pw}}");
      await beaconed("note", tag, SECRET);
      const snap = await c.callTool({ name: "browser_snapshot", arguments: {} });
      for (const r of [typed, snap]) {
        const t = textOf(r);
        expect(isUnsafe(r), t).toBe(false);
        expect(t).not.toContain(SECRET);
        expect(t, t).not.toMatch(/value="\{\{pw\}\}"/);
      }
      await c.callTool({ name: "browser_click", arguments: { ref: nextRef(textOf(snap)), snapshot: false } });
      await beaconed("next", tag, "");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: overlapping configured and typed values (one ends where the other starts) are both kept out: withheld whole; each dispatched as typed (control: a half alone is given)", async () => {
    const configured = "abcd1234";
    const typedValue = "1234wxyz";
    const { own, c } = await freshClient({ key: { value: configured } });
    const tag = `overlap${Date.now()}`;
    try {
      const nav = await navTight(c, "raw", tag);
      givenWith(await typeInto(c, fieldOf(nav, "Note"), "abcd"), "Echo abcd");
      await typeInto(c, fieldOf(nav, "Pass"), typedValue, false);
      await beaconed("pass", tag, typedValue);
      const r = await typeInto(c, fieldOf(nav, "Note"), "abcd1234wxyz");
      withheldWhole(r);
      await beaconed("note", tag, "abcd1234wxyz");
      for (const f of [...allForms(configured), ...allForms(typedValue)]) expect(textOf(r)).not.toContain(f);
      // Leaving this page reports the plain field's old value ("abcd1234wxyz" → ""): that reply holds it too, withheld.
      const away = await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tight?form=raw&t=${tag}x` } });
      withheldWhole(away);
      for (const f of [...allForms(configured), ...allForms(typedValue)]) expect(textOf(away)).not.toContain(f);
      await wholeAgainAndActs(c, `${tag}b`);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: a configured VALUE equal to a ref ('e1') never rewrites a ref: replies withheld whole; a schema-constrained read holding it is withheld before validation (control: a read without it validates); the page was loaded", async () => {
    const { own, c } = await freshClient({ refv: { value: "e1" } });
    const tag = `refv${Date.now()}`;
    try {
      const nav = await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tight?form=raw&t=${tag}` } });
      withheldWhole(nav);
      expect(received).toContain(`/tight?form=raw&t=${tag}`);
      const ok = await c.callTool({ name: "browser_query", arguments: { expression: "'xy'", schema: { type: "string", maxLength: 4 } } });
      expect(isUnsafe(ok), textOf(ok)).toBe(false);
      expect((ok as { structuredContent?: { value: unknown } }).structuredContent?.value).toBe("xy");
      const q = await c.callTool({ name: "browser_query", arguments: { expression: "'xe1y'", schema: { type: "string", maxLength: 4 } } });
      withheldWhole(q);
      expect(textOf(q)).not.toMatch(/schema_mismatch/);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: a configured VALUE equal to a tag name ('button') never rewrites the grammar: the page's reply is withheld whole; the page was loaded (control: without that secret the same page is given with <button>)", async () => {
    const control = await freshClient();
    try {
      givenWith({ content: [{ type: "text", text: await navTight(control.c, "raw", `ctl${Date.now()}`) }] }, "<button>Next");
    } finally {
      await control.c.close();
      await control.own.close();
    }
    const { own, c } = await freshClient({ word: { value: "button" } });
    const tag = `word${Date.now()}`;
    try {
      const nav = await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/tight?form=raw&t=${tag}` } });
      withheldWhole(nav);
      expect(textOf(nav)).not.toMatch(/<\{\{word\}\}/);
      expect(received).toContain(`/tight?form=raw&t=${tag}`);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: a PLACEHOLDER NAMED like grammar ({{button}}) is only a name: the page is given as usual; its value, typed and echoed, is withheld; dispatched with that value", async () => {
    const { own, c } = await freshClient({ button: { value: "Qv9-name-collide" } });
    const tag = `name${Date.now()}`;
    try {
      const nav = await navTight(c, "json", tag);
      givenWith({ content: [{ type: "text", text: nav }] }, "<button>Next");
      const typed = await typeInto(c, fieldOf(nav, "Note"), "{{button}}");
      withheldWhole(typed);
      await beaconed("note", tag, "Qv9-name-collide");
      expect(textOf(typed)).not.toContain("Qv9-name-collide");
      await wholeAgainAndActs(c, `${tag}b`);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: a retired 2-character configured value (expired) stays out of every reply; dispatched with that value (control: the page before it is given)", async () => {
    const { own, c } = await freshClient({ soon: { value: "Rq", expiresAt: Date.now() + 5_000 } });
    const tag = `retired${Date.now()}`;
    try {
      const nav = await navTight(c, "b64", tag);
      givenWith(await typeInto(c, fieldOf(nav, "Note"), "hi"), "Echo aGk=");
      const typed = await typeInto(c, fieldOf(nav, "Note"), "{{soon}}");
      withheldWhole(typed);
      await beaconed("note", tag, "Rq");
      await new Promise((r) => setTimeout(r, 5_500)); // expired now: retired, not dropped
      const later = await c.callTool({ name: "browser_snapshot", arguments: {} });
      withheldWhole(later); // the page still shows it (base64)
      for (const f of allForms("Rq")) expect(textOf(later)).not.toContain(f);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: an issued authenticator code typed into a plain field (never registered as a password) and echoed is withheld; dispatched with a 6-digit code (the 10-minute expiry: secrets.test.ts, fake clock)", async () => {
    const { own, c } = await freshClient({ otp: { totp: "JBSWY3DPEHPK3PXP" } });
    const tag = `otp${Date.now()}`;
    try {
      const nav = await navTight(c, "raw", tag);
      const code = await typeInto(c, fieldOf(nav, "Note"), "{{otp}}");
      withheldWhole(code);
      for (let i = 0; i < 40 && !received.some((u) => u.startsWith(`/tight-log?f=note&t=${tag}&v=`)); i++) await new Promise((r) => setTimeout(r, 50));
      const sent = received.find((u) => u.startsWith(`/tight-log?f=note&t=${tag}&v=`));
      const typedCode = String.fromCodePoint(...sent!.split("&v=")[1]!.split(".").map(Number));
      expect(typedCode, received.join("\n")).toMatch(/^\d{6}$/);
      expect(textOf(code)).not.toContain(typedCode);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: screenshots BEFORE any password, with a configured secret not on the page, are given (pre-password control)", async () => {
    const own = createMcpServer({ config: { headless: true, allowedHosts: ["127.0.0.1"], allowPrivateNetwork: true, interventionTimeoutMs: 30_000, secrets: { pw: { value: SECRET } }, allowScreenshots: true } });
    const c = await connect(own);
    try {
      await navTight(c, "raw", `pre${Date.now()}`);
      const shot = await c.callTool({ name: "browser_screenshot", arguments: {} });
      expect(((shot as { content: { type: string }[] }).content ?? []).some((x) => x.type === "image"), textOf(shot)).toBe(true);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("tightening: after a placeholder typed into a password field, screenshots are withheld for the browser's lifetime (another page too), and given again after browser_close; dispatched with that value", async () => {
    const own = createMcpServer({ config: { headless: true, allowedHosts: ["127.0.0.1"], allowPrivateNetwork: true, interventionTimeoutMs: 30_000, secrets: { pw: { value: SECRET } }, allowScreenshots: true } });
    const c = await connect(own);
    const hasImage = (r: unknown) => ((r as { content: { type: string }[] }).content ?? []).some((x) => x.type === "image");
    const tag = `life${Date.now()}`;
    try {
      const nav = await navTight(c, "none", tag);
      await typeInto(c, fieldOf(nav, "Pass"), "{{pw}}", false);
      await beaconed("pass", tag, SECRET);
      expect(hasImage(await c.callTool({ name: "browser_screenshot", arguments: {} }))).toBe(false);
      await navTight(c, "raw", `${tag}b`);
      const later = await c.callTool({ name: "browser_screenshot", arguments: {} });
      expect(hasImage(later)).toBe(false);
      expect(isUnsafe(later), textOf(later)).toBe(true);
      await c.callTool({ name: "browser_close", arguments: {} });
      await navTight(c, "raw", `${tag}c`);
      expect(hasImage(await c.callTool({ name: "browser_screenshot", arguments: {} }))).toBe(true);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("R4: capture counts stay per client when two clients work at the same time", async () => {
    const logA = join(tmpdir(), `pf-r4a-${process.pid}-${Date.now()}.jsonl`);
    const logB = join(tmpdir(), `pf-r4b-${process.pid}-${Date.now()}.jsonl`);
    const make = (log: string) => {
      process.env["PILOTFISH_MCP_DEBUG_LOG"] = log;
      const s = createMcpServer({ config: { headless: true, allowedHosts: ["127.0.0.1"], allowPrivateNetwork: true, interventionTimeoutMs: 30_000, secrets: {}, allowScreenshots: false } });
      delete process.env["PILOTFISH_MCP_DEBUG_LOG"];
      return s;
    };
    const sa = make(logA);
    const sb = make(logB);
    const [a, b] = [await connect(sa), await connect(sb)];
    try {
      await a.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review`, snapshot: false } });
      await b.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review`, snapshot: false } });
      const qa = async () => { for (let i = 0; i < 12; i++) await a.callTool({ name: "browser_query", arguments: { expression: "document.title" } }); };
      const rb = async () => { for (let i = 0; i < 6; i++) await b.callTool({ name: "browser_snapshot", arguments: { whole_page: true } }); };
      await Promise.all([qa(), rb()]);
      const rows = (f: string) => readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows(logA).filter((r) => r["tool"] === "query").map((r) => r["captures"])).toEqual(Array(12).fill(0));
      expect(rows(logB).filter((r) => r["tool"] === "read_page").every((r) => (r["captures"] as number) >= 1)).toBe(true);
    } finally {
      await a.close();
      await b.close();
      await sa.close();
      await sb.close();
      rmSync(logA, { force: true });
      rmSync(logB, { force: true });
    }
  }, 120_000);

  it("R5: a scope ref is never re-bound to another document's element, with or without a url expectation", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/scope1` } }));
      const box = /\|SCROLL\|\[(e\d+)\]/.exec(nav)![1]!;
      const next = /\[(e\d+)\]<a[^\n]*>Next/.exec(nav)![1]!;
      const out = textOf(await c.callTool({ name: "browser_click", arguments: { ref: next, snapshot: false, expect: { text: "Order placed", in: box, url: "/scope2" } } }));
      expect(out).not.toContain("- expect: MATCHED");
      expect(out).toContain("- expect: AMBIGUOUS");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("R6: hidden text never satisfies an expectation; repeated text is counted as occurrences", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/review` } }));
      const box = /\|SCROLL\|\[(e\d+)\]/.exec(nav)![1]!;
      const hid = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Hide"), snapshot: false, expect: { text: "Ready now", in: box, within: 0.3 } } }));
      expect(hid).not.toContain("- expect: MATCHED");
      const ghost = textOf(await c.callTool({ name: "browser_click", arguments: { ref: snapLine(nav, "Ghost"), snapshot: false, expect: { text: "Ghost text", within: 0.3 } } }));
      expect(ghost).toContain("- expect: UNMET");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("R7: a batch keeps a step's still-loading warning and stops there; step 3 is not run", async () => {
    const { own, c } = await freshClient();
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/batch?mode=loading` } }));
      const size = /\[(e\d+)\]<select[^\n]*Size/.exec(nav)![1]!;
      const out = textOf(await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "select", ref: size, values: ["Large"] }, { action: "click", ref: snapLine(nav, "Two") }, { action: "click", ref: snapLine(nav, "Three") }], snapshot: false } }));
      expect(out).toContain("Stopped after step 2: the page was still loading");
      expect(out).toContain("steps 3-3 were not run");
      const hits = JSON.parse(textOf(await c.callTool({ name: "browser_query", arguments: { expression: "document.getElementById('hits').textContent" } })).split("\n")[0]!);
      expect(hits).toEqual({ s2: 1 });
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("A2 debug log: every call counts its captures and logs its phases as numbers only; a call with no capture logs 0", async () => {
    const log = join(tmpdir(), `pf-mcp-a2-${process.pid}-${Date.now()}.jsonl`);
    process.env["PILOTFISH_MCP_DEBUG_LOG"] = log;
    const own = createMcpServer({ config: { headless: true, allowedHosts: ["127.0.0.1"], allowPrivateNetwork: true, interventionTimeoutMs: 30_000, secrets: {}, allowScreenshots: false } });
    delete process.env["PILOTFISH_MCP_DEBUG_LOG"];
    const c = await connect(own);
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/reground?mode=reorder`, snapshot: false } }));
      expect(nav).toContain("EVIDENCE");
      await c.callTool({ name: "browser_query", arguments: { expression: "document.title" } });
      await c.callTool({ name: "browser_find", arguments: { query: "Bravo" } });
      const read = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const bravo = /\[(e\d+)\]<button[^\n]*>Bravo/.exec(read)![1]!;
      await c.callTool({ name: "browser_actions", arguments: { actions: [{ action: "click", ref: bravo }, { action: "wait", seconds: 0.5 }], snapshot: false } });
      const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.map((r) => r["tool"])).toEqual(["navigate", "query", "find", "read_page", "actions"]);
      const by = (t: string) => rows.find((r) => r["tool"] === t)!;
      expect(by("navigate")["captures"]).toBeGreaterThanOrEqual(1);
      expect(by("query")["captures"]).toBe(0);
      expect(by("find")["captures"]).toBeGreaterThanOrEqual(1);
      expect(by("read_page")["captures"]).toBeGreaterThanOrEqual(1);
      expect(by("actions")["captures"]).toBeGreaterThanOrEqual(2);
      // Phases: numbers under phase names, the loading wait apart from the settle.
      const phases = by("navigate")["phases"] as Record<string, unknown>;
      expect(Object.keys(phases).length).toBeGreaterThan(0);
      for (const r of rows) {
        for (const [k, v] of Object.entries((r["phases"] ?? {}) as Record<string, unknown>)) {
          expect(k).toMatch(/^[a-zA-Z]{1,24}$/);
          expect(typeof v).toBe("number");
        }
        expect(typeof r["captures"]).toBe("number");
        expect(typeof r["captureMs"]).toBe("number");
        // No page words, paths or queries in any row.
        const s = JSON.stringify(r);
        for (const w of ["Bravo", "Alpha", "Xray", "reground", "mode=", "document.title"]) expect(s).not.toContain(w);
      }
    } finally {
      await c.close();
      await own.close();
      rmSync(log, { force: true });
    }
  }, 90_000);

  it("debug log: a full owed to a new address says whether the document generation stayed the same; replies unchanged (17 Nov)", async () => {
    const log = join(tmpdir(), `pf-mcp-debug-${process.pid}-${Date.now()}.jsonl`);
    process.env["PILOTFISH_MCP_DEBUG_LOG"] = log;
    const own = createMcpServer({ config: { headless: true, allowedHosts: ["127.0.0.1"], allowPrivateNetwork: true, interventionTimeoutMs: 30_000, secrets: {}, allowScreenshots: false } });
    delete process.env["PILOTFISH_MCP_DEBUG_LOG"];
    const c = await connect(own);
    try {
      const nav = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/spa` } }));
      const next = /\[(e\d+)\]<button[^\n]*Next view/.exec(nav)![1]!;
      const pushed = textOf(await c.callTool({ name: "browser_click", arguments: { ref: next } }));
      expect(pushed).toContain("PAGE SNAPSHOT");
      expect(pushed).toContain("View 2");
      await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/spa?second` } });
      const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.map((r) => r["reason"])).toEqual(["no-base", "other-document", "other-document"]);
      expect(rows.map((r) => r["sameDocument"])).toEqual([undefined, true, false]);
    } finally {
      await c.close();
      await own.close();
      rmSync(log, { force: true });
    }
  }, 90_000);

  it("(a) an address built from the task's words: its applied query, sort and filter are verified on the page and in the results (17 Nov)", async () => {
    // Built, never shown by the site: the query is the task's words, the sort and the bound the site's own grammar.
    const built = `${origin}/shop?q=wireless+earbuds&sort=price-asc&price=under-2000`;
    const out = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: built, snapshot: false } }));
    expect(out).toContain('page heading: "Results for "wireless earbuds" — page 1, sorted by price, low to high, filters: under ₹2,000"');
    // The results themselves meet the bound and the order.
    const prices = await shopPrices();
    expect(prices.length).toBeGreaterThan(0);
    expect(prices.every((p) => p < 2000)).toBe(true);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  }, 90_000);

  it("(b) a built address the site did not apply: the search box repeats the bound, the heading and results do not; the site's own form applies it (17 Nov)", async () => {
    const built = `${origin}/shop?q=${encodeURIComponent("wireless earbuds under 2000")}`;
    const out = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: built } }));
    // The address and the search box both say "under 2000"; neither is the applied state.
    expect(out.split("\n").find((l) => l.startsWith("- navigated:"))).toContain(built);
    const box = textOf(await client.callTool({ name: "browser_query", arguments: { expression: "document.querySelector('input[name=q]').value" } })).split("\n")[0];
    expect(box).toBe("wireless earbuds under 2000");
    // The heading and the results show the mismatch.
    expect(out).toContain('Results for "wireless earbuds under 2000" — page 1, sorted by relevance, filters: none');
    expect((await shopPrices()).some((p) => p >= 2000)).toBe(true);
    // Fall back to the site's own form: choose its price filter and search.
    const price = /\[(e\d+)\]<select[^\n]*Price/.exec(out)![1]!;
    const search = /\[(e\d+)\]<button[^\n]*Search/.exec(out)![1]!;
    await client.callTool({ name: "browser_select", arguments: { ref: price, values: ["Under ₹2,000"], snapshot: false } });
    const applied = textOf(await client.callTool({ name: "browser_click", arguments: { ref: search, snapshot: false } }));
    expect(applied).toContain("filters: under ₹2,000");
    expect((await shopPrices()).every((p) => p < 2000)).toBe(true);
  }, 90_000);

  it("(c) a session value the site never issued: the page shows its sign-in, not results; the rule forbids writing one (17 Nov)", async () => {
    // The tools do not block such an address (the rule in browser_navigate's description forbids it, checked in
    // server.test.ts); the evidence shows the site refused it, so no result from it can pass as applied.
    const out = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/shop?q=earbuds&sid=made-up-123`, snapshot: false } }));
    expect(out).toContain("Your session has expired. Sign in to continue.");
    expect(out).not.toContain("Results for");
    expect(textOf(await client.callTool({ name: "browser_query", arguments: { expression: "document.querySelectorAll('.item').length" } })).split("\n")[0]).toBe("0");
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === "browser_navigate")!.description).toContain("Never write a sign-in, session, account, identity or tracking value yourself");
  }, 90_000);

  it("snapshot:false keeps the page's own loading checks on an acting tool (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/fares?quiet` } }));
    const search = /\[(e\d+)\]<button[^\n]*Search/.exec(nav)![1]!;
    const quiet = textOf(await client.callTool({ name: "browser_click", arguments: { ref: search, snapshot: false } }));
    // The search's own bar was waited for (the fetched fare is the new text), and the stuck spinner is said.
    expect(quiet).toContain("₹9,108");
    expect(quiet).not.toContain("₹9,584");
    expect(quiet).toContain('Not waited for: "Loading results"');
    expect(quiet).not.toContain("PAGE SNAPSHOT");
  }, 90_000);

  it("a page that says it is still loading is shown once it has finished; a spinner that never stops is waited for once (4 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/loading` } }));
    expect(nav).toMatch(/Waited \d+\.\d s for the page's own loading indicator to finish/);
    expect(nav).toContain("Cheapest from ₹9,564");
    expect(nav).not.toContain("₹10,041");
    // The rating bar (aria-valuenow 65) stayed on that page: a determinate bar is not loading, so the wait ended.
    // An indeterminate bar that never stops: one wait, a note, and no second wait on the same page.
    const spin = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/spinner` } }));
    expect(spin).toMatch(/still shows "loading" after 6\.\d s/);
    const press = /\[(e\d+)\]<button[^\n]*Press/.exec(spin)![1]!;
    const t0 = Date.now();
    const pressed = textOf(await client.callTool({ name: "browser_click", arguments: { ref: press } }));
    expect(pressed).toContain("Pressed");
    expect(pressed).not.toContain("still shows");
    expect(Date.now() - t0).toBeLessThan(5_000);
  }, 60_000);

  it("a spinner that never stops does not hide another indicator beside it: the search's fares are read once fetched (16 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/fares` } }));
    expect(nav).toMatch(/still shows "Loading results" after 6\.\d s/);
    const search = /\[(e\d+)\]<button[^\n]*Search/.exec(nav)![1]!;
    const t0 = Date.now();
    const clicked = textOf(await client.callTool({ name: "browser_click", arguments: { ref: search } }));
    // Before: the stuck spinner was the only label read, so the click returned at once with the early figure.
    expect(clicked).toContain("Cheapest from ₹9,108 (search 1)");
    expect(clicked).not.toContain("₹9,584");
    expect(Date.now() - t0).toBeLessThan(6_000);
    // The spinner that is not waited for is said on the result: nothing tells a new operation behind it from the old.
    expect(clicked).toContain('Not waited for: "Loading results", which outlasted an earlier wait here');
    // A search whose bar outlives the wait: told it still shows, and that bar is exempt for now.
    const slow = /\[(e\d+)\]<button[^\n]*Slow search/.exec(nav)![1]!;
    expect(textOf(await client.callTool({ name: "browser_click", arguments: { ref: slow } }))).toMatch(/still shows "Fetching results" after 6\.\d s/);
    await new Promise((r) => setTimeout(r, 1_500));
    // The bar has gone since: the next search's bar (the same label) is waited for again, not skipped as stuck.
    const again = textOf(await client.callTool({ name: "browser_click", arguments: { ref: search } }));
    expect(again).toContain("Cheapest from ₹9,108 (search 3)");
    expect(again).not.toContain("search 1");
    // The spinner's label never went away (a continuous label): still exempt, and said again on this result too.
    expect(again).toContain('Not waited for: "Loading results"');
    // (A failed read is unknown, never "finished": loadingState in page-text.test.ts. A page holding its thread is
    // waited out by the settle before the read here, so it cannot be staged reliably in a browser test.)
    // A new document in the same tab (the local MCP opens a new-tab link here) keeps the never-stopping spinner exempt
    // and says so on the result, never as finished. (Another tab's exemptions: loadingState, keyed by tab.)
    const open = /\[(e\d+)\]<a[^\n]*Open again/.exec(nav)![1]!;
    const reopened = textOf(await client.callTool({ name: "browser_click", arguments: { ref: open } }));
    expect(reopened).toContain('Not waited for: "Loading results"');
    expect(reopened).not.toMatch(/Waited \d+\.\d s for the page's own loading indicator to finish/);
  }, 90_000);

  it("a change list keeps rows and values together, is per address, and browser_snapshot is always whole (16 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/sort` } }));
    const ref = (name: string) => new RegExp(`\\[(e\\d+)\\]<button[^\\n]*${name}`).exec(nav)![1]!;
    // Two rows swap their scores: never "the same"; each new score right under its own hotel, in page order (on a
    // page this small the change list is over half of it, so it is the whole screen).
    const swapped = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref("Swap") } }));
    expect(swapped).not.toMatch(/PAGE SNAPSHOT \([^)]*\): the same as/);
    expect(swapped).toMatch(/Hotel Aurora[^\n]*\n[^\n]*Score 9\.8[^]*Hotel Borealis[^\n]*\n[^\n]*Score 9\.1/);
    // A re-sort: shown, never "the same".
    const sorted = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref("Sort by score") } }));
    expect(sorted).not.toMatch(/PAGE SNAPSHOT \([^)]*\): the same as/);
    // Only Dune (10) moved, to the top: it is shown there with its score, and where its old lines were is said.
    expect(sorted).toMatch(/<list>\n\t\[e\d+\]<a[^\n]*Hotel Dune\n\tScore 10\n/);
    expect(sorted).toMatch(/~ Score 8\.7\n[^]*\((?:replaces \d+ line\(s\)|\d+ line\(s\) gone here)\)/);
    // Another address with the same content: the whole screen, not a change list against the first address.
    const paged = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref("Page 2") } }));
    expect(paged).not.toContain("CHANGES ONLY");
    expect(paged).not.toMatch(/PAGE SNAPSHOT \([^)]*\): the same as/);
    // An explicit snapshot is whole. C1a2 (18 Nov): the last screen an action returned is still a fresh base for this
    // page (same document, address and scroll, 2 results back), so it is kept: the next change list is against it.
    const snap = textOf(await client.callTool({ name: "browser_snapshot", arguments: {} }));
    expect(snap).not.toContain("CHANGES ONLY");
    expect(snap).toContain("Hotel Aurora");
    const counted = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref("Count") } }));
    expect(counted).toMatch(/CHANGES ONLY since the page snapshot 2 browser results back/);
    expect(counted).toContain("Stays (4)");
    // A fragment change (a hash-routed view) and a reload of the same address are other documents: whole screens.
    const hashed = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref("Hash view") } }));
    expect(hashed).not.toContain("CHANGES ONLY");
    expect(hashed).not.toMatch(/: the same as/);
    const reloaded = textOf(await client.callTool({ name: "browser_click", arguments: { ref: ref("Reload") } }));
    expect(reloaded).not.toContain("CHANGES ONLY");
    expect(reloaded).not.toMatch(/: the same as/);
  }, 60_000);

  it("a suggestion's name and the place under it are printed apart, never as one phrase (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/suggest` } }));
    expect(nav).toContain("North Ridge · Westland");
    expect(nav).toContain("North ridge · Lakes (North Ridge), Westland");
    // Inline markup inside one line stays one phrase.
    expect(nav).toContain("North Ridge Inn");
    expect(nav).not.toContain("North · Ridge Inn");
  }, 60_000);

  it("browser_type on a text field clicks it first: a click-opened widget opens and the value is set with no click before it (17 Nov)", async () => {
    const nav = textOf(await client.callTool({ name: "browser_navigate", arguments: { url: `${origin}/widget` } }));
    expect(nav).not.toContain("Tomorrow");
    const field = /\[(e\d+)\]<input[^\n]*When/.exec(nav)![1]!;
    const typed = textOf(await client.callTool({ name: "browser_type", arguments: { ref: field, text: "Dec 1" } }));
    expect(typed).toContain(`value ${field}: "" → "Dec 1"`);
    expect(typed).toContain("Tomorrow");
    // A native date input gets its value set directly: no click reaches it.
    const day = /\[(e\d+)\]<input[^\n]*type="date"/.exec(typed)?.[1] ?? /\[(e\d+)\]<input[^\n]*Day/.exec(typed)![1]!;
    const dated = textOf(await client.callTool({ name: "browser_type", arguments: { ref: day, text: "2026-12-01" } }));
    expect(dated).toContain("2026-12-01");
    expect(dated).not.toContain("Day was clicked");
  }, 60_000);

  // ---- C1a (18 Nov): a page the client was given whole by browser_snapshot is the base of the next change list ----
  /** A snapshot reply's page lines (after its header line), as a change list is applied to them. */
  const bodyOf = (reply: string) => reply.slice(reply.indexOf("\n", reply.indexOf("PAGE SNAPSHOT (")) + 1);
  const normLines = (body: string) => body.split("\n").map((l) => l.replace(/^(\t*)\*/, "$1").trim());
  const changeListOf = (reply: string) => {
    const at = reply.indexOf("CHANGES ONLY since");
    return at < 0 ? null : reply.slice(reply.indexOf("\n", at) + 1);
  };
  const btn = (page: string, label: string) => new RegExp(`\\[(e\\d+)\\]<button[^\\n]*>${label}`).exec(page)![1]!;

  it("C1a: snapshot then action is a change list against the snapshot, and the client's view rebuilt from them is the page now", async () => {
    const { own, c } = await freshClient();
    try {
      await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1`, snapshot: false } });
      const snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Count") } }));
      expect(counted).toMatch(/PAGE SNAPSHOT \([^)]*\): CHANGES ONLY since the page snapshot 1 browser result back/);
      expect(counted).toContain("Stays+");
      // Base truth: the snapshot the client holds plus this change list is, line for line, the page a fresh snapshot shows.
      const now = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      expect(applyInOrder(bodyOf(snap), changeListOf(counted)!)).toEqual(normLines(bodyOf(now)));
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a: after more than SHOWN_KEEP results, a fresh snapshot is the base again: the next action is a change list, not a base-old page", async () => {
    const { own, c } = await freshClient();
    try {
      await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1` } }); // a full screen: the base
      for (let i = 0; i < 9; i++) await c.callTool({ name: "browser_query", arguments: { expression: "document.title" } });
      const snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Count") } }));
      expect(counted).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a: a withheld snapshot never becomes the base; after it the page is printed whole; a snapshot with a hand-off note is no base either", async () => {
    const { own, c } = await freshClient();
    try {
      const replies: { unsafe: boolean; text: string }[] = [];
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = await c.callTool({ name, arguments: args });
        replies.push({ unsafe: isUnsafe(r), text: textOf(r) });
        return textOf(r);
      };
      const nav = await call("browser_navigate", { url: `${origin}/c1base` });
      const code = /\[(e\d+)\]<input[^\n]*Code/.exec(nav)![1]!;
      const clear = btn(nav, "Clear");
      const count = btn(nav, "Count");
      await call("browser_type", { ref: code, text: SECRET6 });
      expect(replies.at(-1)!.unsafe).toBe(true);
      await call("browser_snapshot");
      expect(replies.at(-1)!.unsafe).toBe(true); // the page still shows the value: withheld, never a base
      const cleared = await call("browser_click", { ref: clear });
      expect(replies.at(-1)!.unsafe, cleared).toBe(false);
      expect(cleared).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
      expect(cleared).toContain("Echo cleared");
      // A password field on the page reads as a sign-in: the snapshot's reply gets a hand-off note, so it is not made a
      // base (only a reply given as printed is). The change list is against the whole page the click above printed.
      const snapped = await call("browser_snapshot");
      expect(snapped).toContain("NEEDS A PERSON");
      const counted = await call("browser_click", { ref: count });
      expect(counted).toMatch(/CHANGES ONLY since the page snapshot 2 browser results back/);
      const log = replies.map((r, i) => `#${i} ${r.unsafe ? "WITHHELD" : "shown"}: ${r.text.slice(0, 300)}`).join("\n---\n");
      for (const [i, r] of replies.entries()) {
        if (r.unsafe) continue;
        for (const f of formsOf(SECRET6)) expect(r.text, `reply ${i} shows ${f}`).not.toContain(f);
        const back = /(?:CHANGES ONLY since|the same as) the page snapshot (\d+) browser results? back/.exec(r.text);
        if (back) expect(replies[i - Number(back[1])]?.unsafe, `reply ${i} is relative to a withheld reply:\n${log}`).toBe(false);
      }
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a: against a snapshot base, the evidence keeps old → new values, removals and new elements not printed; one printed whole is in the page part", async () => {
    const { own, c } = await freshClient();
    try {
      await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1`, snapshot: false } });
      const snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const where = /\[(e\d+)\]<input[^\n]*Where/.exec(snap)![1]!;
      const typed = textOf(await c.callTool({ name: "browser_type", arguments: { ref: where, text: "North" } }));
      expect(typed).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
      expect(typed).toContain(`- value ${where}: "" → "North"`);
      const gadget = btn(snap, "Gadget");
      const removed = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Hide gadget") } }));
      expect(removed).toMatch(/CHANGES ONLY since the page snapshot 2 browser results back/);
      expect(removed).toMatch(new RegExp(`- 1 element\\(s\\) removed: \\[${gadget}\\]<button[^\\n]*Gadget`));
      const far = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Add far") } }));
      // Far below every printed screen: not in the page part, so listed in the evidence.
      expect(far).toMatch(/- 1 new interactive element\(s\): [^\n]*Far button/);
      expect(far.slice(far.indexOf("PAGE SNAPSHOT ("))).not.toContain("Far button");
      const here = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Add here") } }));
      const page = here.slice(here.indexOf("PAGE SNAPSHOT ("));
      const line = /\[(e\d+)\]<button>Here button/.exec(page);
      expect(line, here).not.toBeNull();
      // The evidence counts it and leaves it to the page part, where it is printed with its ref.
      expect(here).toMatch(/- 1 new interactive element\(s\)\n/);
      // The client's view rebuilt from the snapshot and this change list is the page now.
      const now = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      expect(applyInOrder(bodyOf(snap), changeListOf(here)!)).toEqual(normLines(bodyOf(now)));
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a: after a scroll, the snapshot (printed around another scroll position) is no base for the action's screen", async () => {
    const { own, c } = await freshClient();
    try {
      await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1`, snapshot: false } });
      const snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const scrolled = textOf(await c.callTool({ name: "browser_scroll", arguments: { direction: "down" } }));
      expect(scrolled).toContain("PAGE SNAPSHOT");
      expect(scrolled).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
      // The scrolled screen is the base now: a change on it is a change list against that screen.
      await c.callTool({ name: "browser_scroll", arguments: { direction: "up" } });
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Count") } }));
      expect(counted).toContain("Stays+");
      expect(counted).not.toMatch(/CHANGES ONLY since the page snapshot [3-9] browser results back/);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  const FRAMING = "That base is browser_snapshot's printing (the viewport and a screen above and below); the visible screen's own above/below counts, if any, end this line.";
  const COUNT = /\(\d+ interactive elements (?:above|below) the viewport; scroll (?:up|down) to reveal\)/g;
  const headerOf = (reply: string) => reply.slice(reply.indexOf("PAGE SNAPSHOT (")).split("\n")[0]!;

  it("C1a': against a snapshot base the header names the snapshot's printing and ends with the screen's own counts, as the whole screen prints them", async () => {
    const { own, c } = await freshClient();
    try {
      // The whole screen at the top of the page: its own count of what is below it.
      const screen = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1long` } }));
      const screenCounts = screen.slice(screen.indexOf("PAGE SNAPSHOT (")).match(COUNT) ?? [];
      expect(screenCounts.length).toBeGreaterThan(0);
      // C1a2: that screen is a fresh base and would be kept over a snapshot; 8 reads age it past SHOWN_KEEP first.
      for (let i = 0; i < 8; i++) await c.callTool({ name: "browser_query", arguments: { expression: "document.title" } });
      const snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      // The snapshot covers more than the screen, so its own count differs: the reply must carry the screen's.
      expect(bodyOf(snap).match(COUNT)?.join(" ")).not.toBe(screenCounts.join(" "));
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Count") } }));
      const header = headerOf(counted);
      expect(header).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
      expect(header).toContain(FRAMING);
      expect(header.endsWith(` ${screenCounts.join(" ")}`), header).toBe(true);
      // Never among the listed lines: the snapshot plus the change list is the page a fresh snapshot shows.
      const now = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      expect(applyInOrder(bodyOf(snap), changeListOf(counted)!)).toEqual(normLines(bodyOf(now)));
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a': against a screen base the change list is as before: no framing, no extra counts", async () => {
    const { own, c } = await freshClient();
    try {
      const screen = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1` } }));
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(screen, "Count") } }));
      const header = headerOf(counted);
      expect(header).toMatch(/: CHANGES ONLY since the page snapshot 1 browser result back\. Lines not listed are as shown there and their refs still work; "~ " marks an unchanged line shown for context\. \(browser_snapshot gives the whole screen again\.\)$/);
      expect(counted).not.toContain(FRAMING);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a': nothing above or below the visible screen: the framing alone, with no count line, as the whole screen prints none", async () => {
    const { own, c } = await freshClient();
    try {
      const screen = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1zero` } }));
      expect(screen).not.toMatch(COUNT);
      for (let i = 0; i < 8; i++) await c.callTool({ name: "browser_query", arguments: { expression: "document.title" } });
      const snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Count") } }));
      const header = headerOf(counted);
      expect(header).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
      expect(header.endsWith(FRAMING), header).toBe(true);
      expect(counted).not.toMatch(COUNT);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a2: a fresh screen base is kept over a later snapshot: the next action is the screen-base change list, no framing", async () => {
    const { own, c } = await freshClient();
    try {
      const screen = textOf(await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1long` } }));
      await c.callTool({ name: "browser_snapshot", arguments: {} });
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(screen, "Count") } }));
      expect(headerOf(counted)).toMatch(/: CHANGES ONLY since the page snapshot 2 browser results back\. Lines not listed are as shown there and their refs still work; "~ " marks an unchanged line shown for context\. \(browser_snapshot gives the whole screen again\.\)$/);
      expect(counted).not.toContain(FRAMING);
      // Against the screen: the screen plus this change list is the screen now (a fresh whole screen after it agrees).
      expect(applyInOrder(bodyOf(screen), changeListOf(counted)!).join("\n")).toContain("Long+");
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a2: no base (navigate without a screen): the snapshot is the base, with the framing and the screen's own count", async () => {
    const { own, c } = await freshClient();
    try {
      await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1long`, snapshot: false } });
      const snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Count") } }));
      const header = headerOf(counted);
      expect(header).toMatch(/CHANGES ONLY since the page snapshot 1 browser result back/);
      expect(header).toContain(FRAMING);
      expect(header.match(COUNT)?.length).toBe(1);
      expect(header.match(COUNT)?.[0]).not.toBe(bodyOf(snap).match(COUNT)?.[0]);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("C1a: a new document (reload) or a new address on the same document (pushState) after a snapshot is printed whole", async () => {
    const { own, c } = await freshClient();
    try {
      await c.callTool({ name: "browser_navigate", arguments: { url: `${origin}/c1`, snapshot: false } });
      let snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const reloaded = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Reload") } }));
      expect(reloaded).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
      // The next change on the reloaded document (a fresh ref from browser_find, which is no base) is printed whole.
      const found = textOf(await c.callTool({ name: "browser_find", arguments: { query: "Count" } }));
      const counted = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(found, "Count") } }));
      expect(counted).toContain("PAGE SNAPSHOT");
      expect(counted).toContain("Stays+");
      expect(counted).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
      snap = textOf(await c.callTool({ name: "browser_snapshot", arguments: {} }));
      const pushed = textOf(await c.callTool({ name: "browser_click", arguments: { ref: btn(snap, "Push view") } }));
      expect(pushed).toContain("PAGE SNAPSHOT");
      expect(pushed).not.toMatch(/CHANGES ONLY|the same as the page snapshot/);
    } finally {
      await c.close();
      await own.close();
    }
  }, 90_000);

  it("closes the browser; the next call starts a fresh one", async () => {
    expect(pf.session.launched).toBe(true);
    expect(textOf(await client.callTool({ name: "browser_close", arguments: {} }))).toBe("Closed the browser.");
    expect(pf.session.launched).toBe(false);
  }, 30_000);
});

// The CLI as an MCP client starts it, over stdio: packages/mcp/dist/cli.js, or the npm package's cli.js when
// PILOTFISH_MCP_CLI names one (the release workflow points it at the packed package, installed as a user would).
describe.skipIf(!E2E)("the CLI over stdio, with no API key", () => {
  const cli = process.env["PILOTFISH_MCP_CLI"] || fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  /** The version the CLI must report: the installed npm package's own, or 0.0.0-dev for a build from this repository. */
  const expectedVersion = (): string =>
    process.env["PILOTFISH_MCP_CLI"] ? (JSON.parse(readFileSync(join(dirname(cli), "package.json"), "utf8")) as { version: string }).version : "0.0.0-dev";
  let site: Server;
  let origin: string;
  let provider: Server;
  let providerUrl: string;
  const modelCalls: string[] = [];

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const u = req.url ?? "/";
      res.end(u.startsWith("/signin") ? SIGNIN_HTML : u.startsWith("/loading") ? LOADING_HTML : HOME_HTML);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    // Where a model client would send its requests, were one made: a stand-in that records them.
    provider = createServer((req, res) => {
      modelCalls.push(`${req.method} ${req.url}`);
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => provider.listen(0, "127.0.0.1", () => r()));
    providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    site?.close();
    provider?.close();
  });

  /** Starts the CLI with this machine's environment minus every key, token and model setting. */
  async function start(settings: Record<string, string>): Promise<{ client: Client; stderr: () => string }> {
    expect(existsSync(cli), `${cli} is missing: npm run build first`).toBe(true);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/API_KEY|AUTH_TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^OPENAI_|^PILOTFISH_/i.test(k)) env[k] = v;
    for (const k of ["PILOTFISH_CHROME", "PILOTFISH_ADBLOCK_OFFLINE"]) if (process.env[k]) env[k] = process.env[k]!;
    Object.assign(env, { PILOTFISH_HEADLESS: "1", ANTHROPIC_BASE_URL: providerUrl, OPENAI_BASE_URL: providerUrl, ...settings });
    for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY"]) expect(env[k]).toBeUndefined();
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli], env, stderr: "pipe" });
    let err = "";
    transport.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    const client = new Client({ name: "stdio-e2e", version: "1" });
    await client.connect(transport);
    return { client, stderr: () => err };
  }

  it("lists only the browser tools and drives the page: refs, a secret, reading, policy, a person's page, no model request", async () => {
    const { client, stderr } = await start({ PILOTFISH_ALLOWED_HOSTS: "127.0.0.1", PILOTFISH_ALLOW_PRIVATE: "1", PILOTFISH_SECRETS: JSON.stringify({ pw: SECRET }) });
    const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })) as CallToolResult;
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("browser_navigate");
      expect(names.filter((n) => !n.startsWith("browser_") || n === "browser_task" || n === "browser_intervention")).toEqual([]);
      expect(client.getInstructions()).not.toMatch(/browser_task|API key/i);
      expect(client.getInstructions()).toContain("{{pw}}");
      // Its real version, to MCP clients and on the command line.
      expect(client.getServerVersion()).toMatchObject({ name: "pilotfish", version: expectedVersion() });
      expect((await promisify(execFile)(process.execPath, [cli, "--version"])).stdout.trim()).toBe(expectedVersion());

      const nav = await call("browser_navigate", { url: `${origin}/` });
      expect(nav.isError, `${textOf(nav)}\n${stderr()}`).toBeFalsy();
      expect(textOf(nav)).toContain("EVIDENCE");
      const snap = textOf(await call("browser_snapshot"));
      const ref = (re: RegExp) => re.exec(snap)?.[1] ?? "";
      expect(textOf(await call("browser_click", { ref: ref(/\[(e\d+)\]<button[^\n]*Launch/) }))).toContain("Launched the probe");
      // The secret is typed by name; no result shows its value.
      const typed = textOf(await call("browser_type", { ref: ref(/\[(e\d+)\]<input[^\n]*id="tok"/), text: "{{pw}}" }));
      expect(typed).toMatch(/value e\d+: "" → "•+/);
      expect(typed + textOf(await call("browser_get_text"))).not.toContain(SECRET);
      expect(textOf(await call("browser_query", { expression: "document.title" }))).toContain("Console");
      expect(textOf(await call("browser_find", { query: "Launch button" }))).toMatch(/\[e\d+\]<button[^\n]*Launch/);
      expect(textOf(await call("browser_actions", { actions: [{ action: "select", ref: ref(/\[(e\d+)\]<select/), values: ["Large"] }, { action: "press", key: "Tab" }] }))).toMatch(/^1\. [^\n]*\n(?: {3}[^\n]*\n)*2\. /);
      // Secrets configured: no screenshot. An irreversible click needs a person this client cannot ask.
      expect(textOf(await call("browser_screenshot"))).toMatch(/Screenshots are off/);
      expect(textOf(await call("browser_click", { ref: ref(/\[(e\d+)\]<button[^\n]*Delete draft/) }))).toMatch(/Blocked by policy: Target looks irreversible.*cannot ask/);
      // A page still loading is shown once it has finished; a sign-in comes back for a person.
      expect(textOf(await call("browser_navigate", { url: `${origin}/loading` }))).toContain("Cheapest from ₹9,564");
      const signin = textOf(await call("browser_navigate", { url: `${origin}/signin` }));
      expect(signin).toMatch(/NEEDS A PERSON \(login[^)]*\)/);
      expect(signin).toContain("This browser is headless");
      expect(textOf(await call("browser_close"))).toBe("Closed the browser.");
      expect(modelCalls).toEqual([]);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("keeps the browser off private networks unless PILOTFISH_ALLOW_PRIVATE is set", async () => {
    const { client } = await start({});
    try {
      for (const url of [`${origin}/`, "http://10.1.2.3/"]) {
        const r = (await client.callTool({ name: "browser_navigate", arguments: { url } }, undefined, { timeout: 60_000 })) as CallToolResult;
        expect(r.isError, url).toBe(true);
        expect(textOf(r)).toMatch(/Blocked by policy: Navigation to private\/loopback address/);
      }
      await client.callTool({ name: "browser_close", arguments: {} });
    } finally {
      await client.close();
    }
    expect(modelCalls).toEqual([]);
  }, 120_000);
});
