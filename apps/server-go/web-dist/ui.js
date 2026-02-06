const $ = (id) => document.getElementById(id);
const qs = (sel, root=document) => root.querySelector(sel);
const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const state = {
  headers: [{k:'Accept', v:'application/json'}],
  presets: [],
  token: localStorage.getItem('stressless_token') || '',
  user: null,
  resp: null,
  respRaw: '',
  discoverMeta: {}
};

function esc(s){ return (s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }

function escapeHtml(s){
  return (s||'')
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;');
}

function tryParseJson(text){
  if (!text) return null;
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try { return JSON.parse(t); } catch { return null; }
}

function highlightJSON(text){
  const obj = tryParseJson(text);
  if (obj === null) return null;
  const pretty = JSON.stringify(obj, null, 2);

  // Tokenize with a single regex pass.
  // Matches: strings (keys/values), numbers, booleans, null, punctuation
  const rx = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\\s*:)?|\\btrue\\b|\\bfalse\\b|\\bnull\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+\\-]?\\d+)?|[{}\\[\\],:])/g;

  return escapeHtml(pretty).replace(rx, (m) => {
    const raw = m;
    // After escapeHtml, quotes remain quotes, punctuation remains punctuation.
    if (raw.startsWith('"') && raw.endsWith(':')) return `<span class="tok-key">${raw}</span>`;
    if (raw.startsWith('"')) return `<span class="tok-str">${raw}</span>`;
    if (raw === 'true' || raw === 'false') return `<span class="tok-bool">${raw}</span>`;
    if (raw === 'null') return `<span class="tok-null">${raw}</span>`;
    if (/^-?\d/.test(raw)) return `<span class="tok-num">${raw}</span>`;
    return `<span class="tok-punc">${raw}</span>`;
  });
}

function pretty(body, headers){
  const ct = (headers && (headers['Content-Type']||headers['content-type']||'')) || '';
  if (ct.toLowerCase().includes('application/json')) { try { return JSON.stringify(JSON.parse(body), null, 2); } catch {} }
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch {}
  return body || '';
}
function setMeta(text){ $('respMeta').textContent = text; }

function renderHeaders(){
  const host = $('headers');
  host.innerHTML = '';
  state.headers.forEach((h, idx) => {
    const row = document.createElement('div');
    row.className = 'kvRow';
    row.innerHTML = `
      <input class="input compact" placeholder="Header" value="${esc(h.k)}" data-idx="${idx}" data-kind="k">
      <input class="input compact" placeholder="Value" value="${esc(h.v)}" data-idx="${idx}" data-kind="v">
      <button class="btn ghost compact" data-idx="${idx}" title="Remove">✕</button>
    `;
    host.appendChild(row);
  });

  qsa('input', host).forEach(inp => inp.addEventListener('input', (e) => {
    const i = Number(e.target.dataset.idx);
    const kind = e.target.dataset.kind;
    state.headers[i][kind] = e.target.value;
  }));

  qsa('button', host).forEach(btn => btn.addEventListener('click', (e) => {
    const i = Number(e.target.dataset.idx);
    state.headers.splice(i, 1);
    if (state.headers.length === 0) state.headers = [{k:'Accept', v:'application/json'}];
    renderHeaders();
  }));
}

function collectHeaders(){
  const out = {};
  state.headers.forEach(({k,v}) => {
    const kk = (k||'').trim();
    if (!kk) return;
    out[kk] = v ?? '';
  });

  const authMode = $('authMode').value;
  const authValue = $('authValue').value.trim();
  const authKey = $('authKey').value.trim();

  if (authMode === 'bearer' && authValue) out['Authorization'] = authValue.startsWith('Bearer ') ? authValue : ('Bearer ' + authValue);
  if (authMode === 'header' && authKey && authValue) out[authKey] = authValue;

  return out;
}

async function api(url, opts={}){
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function send(){
  setMeta('Sending…');
  $('respBody').textContent = '';
  $('respHeaders').textContent = '';
  $('respRaw').textContent = '';

  const req = {
    method: $('method').value,
    url: $('url').value.trim(),
    headers: collectHeaders(),
    body: $('body').value,
    timeoutMs: 25000
  };

  const t0 = performance.now();
  const res = await fetch('/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(req) });
  const raw = await res.text();
  state.respRaw = raw;

  if (!res.ok){
    setMeta('Error');
    $('respRaw').textContent = raw;
    assistantTip('Request failed', 'Check URL, auth, and connectivity. The backend requires http/https URLs.');
    return;
  }

  const data = JSON.parse(raw);
  state.resp = data;

  if (!data.ok){
    setMeta('Error');
    $('respRaw').textContent = raw;
    assistantTip('Proxy error', data.error || 'Unknown error');
    return;
  }

  const dt = Math.round(performance.now() - t0);
  setMeta(`${data.status} • ${data.durationMs}ms • total ${dt}ms`);
  $('respHeaders').textContent = JSON.stringify(data.headers, null, 2);
  const hl = highlightJSON(data.body);
  if (hl){ $('respBody').classList.add('syntax'); $('respBody').innerHTML = hl; }
  else { $('respBody').classList.remove('syntax'); $('respBody').textContent = (data.body||''); }
  $('respRaw').textContent = raw;

  if (data.status >= 200 && data.status < 300){
    assistantTip('Response received', 'Looks good. Save it as a preset if you will reuse it.');
  } else {
    assistantTip('Non-2xx response', 'This can be valid. Inspect body and headers for error details.');
  }
}

async function loadPresets(){
  state.presets = await api('/api/presets');
  renderPresetList();
}

function short(s){ return !s ? '' : (s.length > 54 ? s.slice(0, 51) + '…' : s); }
function renderPresetList(){
  const host = $('presetList');
  host.innerHTML = '';
  const list = [...state.presets].sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''));
  if (list.length === 0){
    const empty = document.createElement('div');
    empty.className = 'presetItem';
    empty.innerHTML = `<div class="presetMeta"><div class="pName">No presets yet</div><div class="pSub">Click “Save preset” after a good request.</div></div>`;
    host.appendChild(empty);
    return;
  }

  list.forEach(p => {
    const item = document.createElement('div');
    item.className = 'presetItem';
    item.innerHTML = `
      <div class="presetMeta">
        <div class="pName">${esc(p.name || 'Preset')}</div>
        <div class="pSub"><span class="badge">${esc(p.method||'GET')}</span> ${esc(short(p.url||''))}</div>
      </div>
      <div class="row">
        <button class="btn ghost compact" data-act="load">Load</button>
        <button class="btn compact" data-act="apply-url">Use URL</button>
      </div>
    `;
    item.addEventListener('click', (e) => {
      const act = e.target?.dataset?.act;
      if (!act) return;
      if (act === 'load') applyPreset(p);
      if (act === 'apply-url'){ $('url').value = p.url || ''; $('method').value = p.method || 'GET'; }
    });
    host.appendChild(item);
  });
}

function applyPreset(p){
  $('method').value = p.method || 'GET';
  $('url').value = p.url || '';
  $('body').value = p.body || '';
  $('authMode').value = p.authMode || 'none';
  $('authKey').value = p.authKey || 'X-API-Key';
  $('authValue').value = p.authValue || '';
  state.headers = Object.entries(p.headers || {}).map(([k,v])=>({k,v}));
  if (state.headers.length === 0) state.headers = [{k:'Accept', v:'application/json'}];
  renderHeaders();
  view('composer');
  assistantTip('Preset loaded', 'You can edit and send immediately.');
}

async function savePreset(){
  const name = prompt('Preset name?', 'Preset ' + new Date().toISOString().slice(0,19).replace('T',' '));
  if (!name) return;
  const payload = {
    name,
    method: $('method').value,
    url: $('url').value.trim(),
    headers: collectHeaders(),
    body: $('body').value,
    authMode: $('authMode').value,
    authKey: $('authKey').value,
    authValue: $('authValue').value,
  };
  await api('/api/presets', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)});
  await loadPresets();
  assistantTip('Preset saved', 'Stored locally by the backend (gitignored by default).');
}

async function loginFlow(){
  if (state.user){
    state.token = '';
    state.user = null;
    localStorage.removeItem('stressless_token');
    renderUser();
    assistantTip('Signed out', 'Local mode is still fully functional.');
    return;
  }
  const username = prompt('Username?', 'pippi') || '';
  if (!username.trim()) return;
  const password = prompt('Password? (alpha: anything)') || '';
  const res = await api('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username, password})});
  if (!res.ok){
    assistantTip('Login failed', res.error || 'Unknown error');
    return;
  }
  state.token = res.token;
  localStorage.setItem('stressless_token', res.token);
  state.user = res.profile;
  renderUser();
  assistantTip('Signed in', 'Auth is alpha, but it unblocks future multi-profile workflows.');
}

async function loadMe(){
  const tok = state.token;
  if (!tok) return;
  try{
    const res = await fetch('/api/auth/me', {headers:{'Authorization':'Bearer ' + tok}});
    const me = await res.json();
    if (me.ok){ state.user = me.profile; renderUser(); }
  } catch {}
}

function renderUser(){
  const name = state.user?.username ? state.user.username : 'Not signed in';
  const role = state.user?.role ? state.user.role : 'Local mode';
  $('userName').textContent = name;
  $('userRole').textContent = role;
  $('avatar').textContent = (name && name !== 'Not signed in') ? name.trim()[0].toUpperCase() : '?';
  $('btnLogin').textContent = state.user ? `Sign out` : `Sign in`;
}

let es = null;

function addFeed(kind, message, meta){
  const row = document.createElement('div');
  row.className = 'feedRow';
  row.innerHTML = `<div class="pill">${esc(kind)}</div><div><div>${esc(message)}</div>${meta?`<div class="muted" style="margin-top:6px;font-family:var(--mono);font-size:12px">${esc(JSON.stringify(meta))}</div>`:''}</div>`;
  $('discoverFeed').prepend(row);
}

function renderChips(meta){
  const host = $('chips');
  host.innerHTML = '';
  const add = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.addEventListener('click', fn);
    host.appendChild(b);
  };
  if (meta.api_base) add('Use API base', ()=>{ $('url').value = meta.api_base; view('composer'); });
  if (meta.docs_url) add('Open docs', ()=>window.open(meta.docs_url, '_blank'));
  if (meta.auth) add('Set Bearer auth', ()=>{ $('authMode').value = 'bearer'; view('composer'); });
  if (meta.openapi_source) add('Copy OpenAPI source', ()=>navigator.clipboard.writeText(meta.openapi_source));
  if (meta.openapi_url) add('Copy OpenAPI URL', ()=>navigator.clipboard.writeText(meta.openapi_url));
}

function connectSSE(){
  if (es) return;
  es = new EventSource('/api/discover/events');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    addFeed(ev.kind, ev.message, ev.meta);
    if ((ev.kind === 'suggestion' || ev.kind === 'finding') && ev.meta){
      state.discoverMeta = {...state.discoverMeta, ...ev.meta};
      renderChips(state.discoverMeta);
      assistantTip('Discovery hint', ev.message);
    }
  };
}

async function discoverStart(){
  $('discoverFeed').innerHTML = '';
  state.discoverMeta = {};
  renderChips({});
  connectSSE();
  const target = $('discoverTarget').value.trim();
  try{
    await api('/api/discover/start', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({target})});
    assistantTip('Discover started', 'Streaming events in the feed. Click chips to apply.');
  } catch (e){
    assistantTip('Discover error', e.message || 'Failed to start');
  }
}

async function discoverStop(){
  try{ await api('/api/discover/stop', {method:'POST'}); } catch {}
  assistantTip('Discover stop', 'If a scan is running, it will cancel shortly.');
}

/* Views */
function view(name){
  qsa('.navBtn').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  qsa('.view').forEach(v=>v.classList.add('hidden'));
  $('view-' + name).classList.remove('hidden');

  const titles = {
    composer: ['Composer', 'Build requests with confidence'],
    presets: ['Presets', 'Reusable blueprints'],
    discover: ['Connect & Discover', 'Learn entry points and auth patterns'],
    about: ['About', 'Alpha with serious intentions']
  };
  $('crumb').textContent = titles[name][0];
  $('crumbHint').textContent = titles[name][1];

  if (name === 'presets') loadPresets().catch(()=>{});
  if (name === 'discover') connectSSE();
}

/* Assistant */
function assistantTip(title, text){
  const host = $('assistantBody');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = `<div class="bTitle">${esc(title)}</div><div class="bText">${esc(text || '')}</div>`;
  host.prepend(bubble);
  // keep last 50
  while (host.children.length > 50) host.removeChild(host.lastChild);
}
function assistantAsk(){
  const q = $('assistantInput').value.trim();
  if (!q) return;
  $('assistantInput').value = '';
  // alpha: local canned hints
  if (q.toLowerCase().includes('cors')) assistantTip('CORS', 'Use the built-in /api/send proxy. The browser will stay calm.');
  else if (q.toLowerCase().includes('openapi')) assistantTip('OpenAPI', 'Try Connect & Discover. If you find openapi.json, you can auto-generate routes in the next opus.');
  else if (q.toLowerCase().includes('auth')) assistantTip('Auth', 'Set Bearer or custom header. Avoid storing secrets in presets.');
  else assistantTip('Tip', 'Use Ctrl+Enter to send, Ctrl+S to save, Ctrl+K for discovery.');
}

/* Hotkeys modal */
function openHotkeys(){ $('modalHotkeys').classList.remove('hidden'); }
function closeHotkeys(){ $('modalHotkeys').classList.add('hidden'); }

document.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape') closeHotkeys();
  if (e.ctrlKey && e.key === 'Enter'){ e.preventDefault(); send(); }
  if (e.ctrlKey && (e.key === 's' || e.key === 'S')){ e.preventDefault(); savePreset(); }
  if (e.ctrlKey && (e.key === 'k' || e.key === 'K')){ e.preventDefault(); view('discover'); }
});

/* Tabs */
function setTab(name){
  qsa('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  $('tab-body').classList.toggle('hidden', name!=='body');
  $('tab-headers').classList.toggle('hidden', name!=='headers');
  $('tab-raw').classList.toggle('hidden', name!=='raw');
}

/* Wire up */
qsa('.navBtn').forEach(b=>b.addEventListener('click', ()=>view(b.dataset.view)));
$('btnSend').addEventListener('click', send);
$('btnSave').addEventListener('click', savePreset);
$('btnNew').addEventListener('click', ()=>{ $('method').value='GET'; $('url').value=''; $('body').value=''; $('authMode').value='none'; $('authValue').value=''; assistantTip('New request', 'Fresh canvas.'); });
$('btnAddHeader').addEventListener('click', ()=>{ state.headers.push({k:'',v:''}); renderHeaders(); });
$('btnCopyBody').addEventListener('click', ()=>navigator.clipboard.writeText($('respBody').textContent||''));
$('btnRefreshPresets').addEventListener('click', loadPresets);
$('btnDiscoverStart').addEventListener('click', discoverStart);
$('btnDiscoverStop').addEventListener('click', discoverStop);
$('btnLogin').addEventListener('click', loginFlow);
$('assistantSend').addEventListener('click', assistantAsk);
$('assistantInput').addEventListener('keydown', (e)=>{ if(e.key==='Enter') assistantAsk(); });
$('btnHotkeys').addEventListener('click', openHotkeys);
$('btnCloseHotkeys').addEventListener('click', closeHotkeys);
$('modalHotkeys').addEventListener('click', (e)=>{ if(e.target.id==='modalHotkeys') closeHotkeys(); });

qsa('.tab').forEach(t=>t.addEventListener('click', ()=>setTab(t.dataset.tab)));

/* Init */
renderHeaders();
assistantTip('Welcome', 'This is Stressless-win. Serious UI. Practical guts.');
assistantTip('Start here', 'Paste a URL, set auth, hit Send. Use Connect & Discover for entry points.');
loadPresets().catch(()=>{});
loadMe().finally(renderUser);
setTab('body');
view('composer');
