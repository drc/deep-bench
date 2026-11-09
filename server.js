// Deep Bench — NFL rarity trivia demo server (zero deps)
// Decisioning: local dataset grades instantly; typesafe/jev-router (OpenRouter)
// adjudicates long-tail answers and tiers candidates when an API key is set.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 4310;
const JEV_MODEL = 'typesafe/jev-router';

const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'dataset.json'), 'utf8'));
const JEV_CACHE_PATH = path.join(ROOT, 'data', 'jev-cache.json');
const KEY_PATH = path.join(ROOT, 'data', '.jevkey');
let jevKey = process.env.OPENROUTER_API_KEY || (fs.existsSync(KEY_PATH) ? fs.readFileSync(KEY_PATH, 'utf8').trim() : null);
let jevCache = fs.existsSync(JEV_CACHE_PATH) ? JSON.parse(fs.readFileSync(JEV_CACHE_PATH, 'utf8')) : {};

// ---------- utils ----------
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const name = k => D.players[k].name;
const fame = k => D.players[k].fame;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// heuristic tier from fame ranks within a candidate pool
function heuristicTiers(cands) {
  // cands: [{key,name,fame}] sorted fame desc
  const n = cands.length;
  return cands.map((c, i) => {
    const f = n === 1 ? 0 : i / (n - 1); // 0 = most famous
    const tier = f < 0.22 ? 'common' : f < 0.55 ? 'uncommon' : f < 0.85 ? 'rare' : 'deep';
    return { ...c, tier };
  });
}

// ---------- question pools ----------
const pool = { tp: [], tn: [], mt: [] };
for (const [team, poss] of Object.entries(D.team_pos)) {
  for (const [pos, keys] of Object.entries(poss)) {
    if (keys.length < 3) continue;
    const cands = keys.map(k => ({ key: k, name: name(k), fame: fame(k) })).sort((a, b) => b.fame - a.fame);
    if (cands[0].fame < 14) continue; // needs a recognizable anchor
    pool.tp.push({ id: `tp:${team}:${pos}`, mode: 'tp', team, pos, cands });
  }
}
for (const [team, nums] of Object.entries(D.team_num)) {
  for (const [num, keys] of Object.entries(nums)) {
    if (keys.length < 2) continue;
    const cands = keys.map(k => ({ key: k, name: name(k), fame: fame(k) })).sort((a, b) => b.fame - a.fame);
    pool.tn.push({ id: `tn:${team}:${num}`, mode: 'tn', team, num, cands });
  }
}
for (const [key, p] of Object.entries(D.players)) {
  const teams = Object.entries(p.teams);
  if (teams.length < 2 || p.n_seasons < 4) continue;
  const tenures = teams.map(([t, v]) => ({ team: t, n: v.n }));
  const min = Math.min(...tenures.map(t => t.n));
  if (tenures.filter(t => t.n === min).length > Math.ceil(teams.length / 2)) continue;
  pool.mt.push({ id: `mt:${key}`, mode: 'mt', key, player: p.name, tenures: tenures.sort((a, b) => b.n - a.n) });
}

function pickDaily(dateStr, team) {
  const seed = [...(dateStr + '|' + (team || ''))].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7);
  const rnd = mulberry32(seed);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const f = arr => team
    ? arr.filter(q => q.team === team || (q.tenures && q.tenures.some(t => t.team === team)))
    : arr;
  const tp = f(pool.tp), tn = f(pool.tn), mt = f(pool.mt);
  return { tp: pick(tp), tn: pick(tn), mt: pick(mt), counts: { tp: tp.length, tn: tn.length, mt: mt.length } };
}

// ---------- answer matching ----------
function matchCandidate(q, answer) {
  const a = norm(answer);
  if (!a) return null;
  const cands = q.cands || [];
  for (const c of cands) if (norm(c.name) === a) return c;
  for (const c of cands) {
    const cn = norm(c.name);
    if (cn.endsWith(' ' + a) || cn === a) return c; // last-name match
  }
  // fuzzy: single typo tolerance against last names
  for (const c of cands) {
    const last = norm(c.name).split(' ').pop();
    if (last.length >= 5 && lev(a, last) <= (a.length > 6 ? 2 : 1)) return c;
  }
  return null;
}
function lev(a, b) {
  const m = [];
  for (let i = 0; i <= a.length; i++) m[i] = [i];
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}

// ---------- jev router ----------
async function jev(messages, maxTokens = 800) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jevKey}` },
    body: JSON.stringify({ model: JEV_MODEL, messages, max_tokens: maxTokens, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return JSON.parse(j.choices[0].message.content);
}

function qPrompt(q) {
  switch (q.mode) {
    case 'tp': return `Name any player who has played ${q.pos} for the ${D.teams[q.team]} at any point in franchise history.`;
    case 'tn': return `Name any player who has worn jersey number #${q.num} for the ${D.teams[q.team]} at any point in franchise history.`;
    case 'mt': return `${q.player} played for ${q.tenures.length} NFL teams. Which one did he spend the FEWEST seasons with?`;
  }
}

// jev adjudication for an answer not found in the dataset
async function jevAdjudicate(q, answer) {
  const cacheKey = `${q.id}|${norm(answer)}`;
  if (jevCache[cacheKey]) return jevCache[cacheKey];
  const out = await jev([
    { role: 'system', content: 'You are an NFL trivia judge. You know NFL rosters and history precisely. Respond ONLY with JSON: {"valid": boolean, "tier": "common"|"uncommon"|"rare"|"deep", "note": string}. valid = the named player/answer actually satisfies the question. tier = how likely a typical NFL fan is to give this same answer: common (most people), uncommon (seasoned fans), rare (dedicated fans), deep (deepest-cut knowledge — only die-hard superfans or historians would name it).' },
    { role: 'user', content: `Question: ${qPrompt(q)}\nProposed answer: ${answer}\nJudge it.` },
  ], 300);
  jevCache[cacheKey] = out;
  try { fs.writeFileSync(JEV_CACHE_PATH, JSON.stringify(jevCache)); } catch {}
  return out;
}

// jev tiering of the full candidate list for a question
async function jevTier(q) {
  if (jevCache['tier|' + q.id]) return jevCache['tier|' + q.id];
  const list = q.cands ? q.cands.map(c => c.name) : null;
  const out = await jev([
    { role: 'system', content: 'You rank NFL player name popularity among typical NFL fans. Respond ONLY with JSON: {"tiers": {"<exact player name>": "common"|"uncommon"|"rare"|"deep"}}. common = most fans name them quickly; uncommon = seasoned fans; rare = dedicated fans; deep = deepest-cut, only superfans name them.' },
    { role: 'user', content: `Question: ${qPrompt(q)}\nCandidate answers:\n${list.map(n => '- ' + n).join('\n')}\nAssign a tier to each.` },
  ], 2000);
  jevCache['tier|' + q.id] = out;
  try { fs.writeFileSync(JEV_CACHE_PATH, JSON.stringify(jevCache)); } catch {}
  return out;
}

// ---------- scoring ----------
const TIER_POINTS = { common: 10, uncommon: 50, rare: 100, deep: 200 };
const pulses = {}; // "date|qid|normAnswer" -> count

function grade(q, answer, tiers, dateStr) {
  let m = q.mode === 'mt' ? matchMT(q, answer) : matchCandidate(q, answer);
  if (!m) return { status: 'not_found', note: q.mode === 'mt'
    ? 'Doesn\'t match any of his teams — recall another stint and try again.'
    : 'Answer not in roster database (2002+).' };
  if (q.mode !== 'mt' && !m.tier) {
    const t = heuristicTiers(q.cands).find(x => x.key === m.key);
    m.tier = t ? t.tier : 'uncommon';
  }
  let tier = m.tier;
  const pulseKey = `${dateStr}|${q.id}|${norm(m.name)}`;
  pulses[pulseKey] = (pulses[pulseKey] || 0) + 1;
  const total = Object.entries(pulses).filter(([k]) => k.startsWith(`${dateStr}|${q.id}|`)).reduce((a, [, v]) => a + v, 0);
  return {
    status: 'ok',
    answer: m.name,
    tier,
    points: TIER_POINTS[tier],
    picked: pulses[pulseKey],
    pickedPct: Math.round((pulses[pulseKey] / total) * 100),
    totalAnswers: total,
  };
}
function matchMT(q, answer) {
  const a = norm(answer);
  const t = q.tenures.find(x => norm(D.teams[x.team]).includes(a) || norm(x.team) === a || a.includes(norm(D.teams[x.team])));
  if (!t) return null;
  const min = q.tenures[q.tenures.length - 1].n;
  const correct = t.n === min;
  const tier = !correct ? 'common' : t.n === 1 ? 'deep' : t.n === 2 ? 'rare' : 'uncommon';
  return { name: D.teams[t.team], tier, tenure: t.n, correct };
}

// ---------- drive game (5 questions -> field goal) ----------
const GAMES = new Map();
const YARDAGE = { deep: 14, rare: 12, uncommon: 9, common: 6 };
const DRIVE_START = 25; // own 25
const KICK_ODDS = d => d <= 29 ? 0.96 : d <= 34 ? 0.92 : d <= 39 ? 0.86 : d <= 44 ? 0.78 : d <= 49 ? 0.70 : d <= 54 ? 0.55 : d <= 59 ? 0.40 : 0.12;

function drawQuestion(list) { return list[Math.floor(Math.random() * list.length)]; }
function pickN(list, n) {
  const c = [...list];
  for (let i = c.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [c[i], c[j]] = [c[j], c[i]];
  }
  return c.slice(0, n);
}

function newGame(team) {
  const f = arr => {
    const filtered = team ? arr.filter(q => q.team === team) : arr;
    return filtered.length ? filtered : arr;
  };
  // mixed bag: 2-3 position questions + the rest number questions
  const tpN = 2 + Math.floor(Math.random() * 2);
  const qs = [...pickN(f(pool.tp), tpN), ...pickN(f(pool.tn), 5 - tpN)];
  const order = qs.sort(() => Math.random() - 0.5);
  const g = { id: Math.random().toString(36).slice(2, 10), team, questions: order, idx: 0, yards: 0, log: [], status: 'active' };
  GAMES.set(g.id, g);
  return g;
}

function gameView(g) {
  return {
    gameId: g.id, team: g.team, idx: g.idx, total: g.questions.length,
    status: g.status, yards: g.yards,
    ballAt: Math.min(99, DRIVE_START + g.yards),
    log: g.log,
    question: g.status === 'active' ? { id: g.questions[g.idx].id, mode: g.questions[g.idx].mode, prompt: qPrompt(g.questions[g.idx]) } : null,
  };
}

async function gameAnswer(g, answer) {
  if (g.status !== 'active') return { error: 'drive not active' };
  const q = g.questions[g.idx];
  const r = await gameAdjudicatedAnswer(g, answer);
  let gained = 0, tier = null, shown = answer;
  if (r.status === 'ok') {
    tier = r.tier; gained = YARDAGE[tier]; shown = r.answer;
    g.yards += gained;
  }
  g.log.push({ n: g.idx + 1, mode: q.mode, answer: shown, tier: tier || 'miss', gained, source: r.source || 'db', note: r.note || null });
  g.idx++;
  if (g.idx >= g.questions.length) {
    g.status = 'kick';
    const dist = (100 - (DRIVE_START + g.yards)) + 17;
    return { view: gameView(g), verdict: { tier: tier || 'miss', gained, note: r.note || null, answer: shown, status: r.status }, fg: { dist, prob: Math.round(KICK_ODDS(dist) * 100) } };
  }
  return { view: gameView(g), verdict: { tier: tier || 'miss', gained, note: r.note || null, answer: shown, status: r.status } };
}

function gameKick(g) {
  if (g.status !== 'kick') return { error: 'not in kick phase' };
  const dist = (100 - (DRIVE_START + g.yards)) + 17;
  const prob = KICK_ODDS(dist);
  const made = Math.random() < prob;
  g.status = 'done';
  g.log.push({ n: 'K', mode: 'kick', answer: `${dist}-yard field goal`, tier: made ? 'made' : 'missed', gained: 0, made });
  return { view: gameView(g), kick: { dist, prob: Math.round(prob * 100), made, points: made ? 3 : 0 } };
}

async function gameAdjudicatedAnswer(g, answer) {
  // like /api/grade's long-tail path but inside a game
  const q = g.questions[g.idx];
  const direct = grade(q, answer, null, new Date().toISOString().slice(0, 10));
  if (direct.status === 'ok' || !jevKey) return direct;
  try {
    const verdict = await jevAdjudicate(q, answer);
    if (verdict.valid) return { status: 'ok', answer, tier: verdict.tier, points: TIER_POINTS[verdict.tier], source: 'jev', note: verdict.note };
    return { status: 'wrong', source: 'jev', note: verdict.note };
  } catch (e) {
    return { ...direct, note: direct.note + ' (jev unavailable: ' + e.message + ')' };
  }
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (p.startsWith('/api/')) {
      const body = await new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d ? JSON.parse(d) : {})); });
      if (p === '/api/daily') {
        const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
        const team = (url.searchParams.get('team') || '').toUpperCase() || null;
        const qs = pickDaily(date, team);
        return send(200, {
          date,
          team,
          coverage: D.coverage,
          teams: D.teams,
          counts: qs.counts,
          questions: {
            tp: { ...qs.tp, prompt: qPrompt(qs.tp), cands: undefined },
            tn: { ...qs.tn, prompt: qPrompt(qs.tn), cands: undefined },
            mt: { ...qs.mt, prompt: qPrompt(qs.mt), tenures: undefined },
          },
        });
      }
      if (p === '/api/grade') {
        const { mode, qid, answer, date } = body;
        const poolArr = { tp: pool.tp, tn: pool.tn, mt: pool.mt }[mode] || [];
        const q = poolArr.find(q => q.id === qid);
        if (!q) return send(400, { error: 'bad qid' });
        const d = date || new Date().toISOString().slice(0, 10);
        const direct = grade(q, answer, null, d);
        if (direct.status === 'ok') return send(200, direct);
        // long tail -> jev adjudication
        if (jevKey) {
          try {
            const verdict = await jevAdjudicate(q, answer);
            if (verdict.valid) {
              const pulseKey = `${d}|${q.id}|${norm(answer)}`;
              pulses[pulseKey] = (pulses[pulseKey] || 0) + 1;
              return send(200, { status: 'ok', answer, tier: verdict.tier, points: TIER_POINTS[verdict.tier], source: 'jev', note: verdict.note });
            }
            return send(200, { status: 'wrong', source: 'jev', note: verdict.note });
          } catch (e) {
            return send(200, { ...direct, note: direct.note + ' (jev unavailable: ' + e.message + ')' });
          }
        }
        return send(200, { ...direct, note: mode === 'mt'
          ? direct.note
          : direct.note + ' Set a jev key in Settings to adjudicate long-tail answers like this.' });
      }
      if (p === '/api/lookup') {
        const type = url.searchParams.get('type');
        const team = (url.searchParams.get('team') || '').toUpperCase();
        const pos = (url.searchParams.get('pos') || '').toUpperCase();
        const num = url.searchParams.get('num');
        const query = url.searchParams.get('q') || '';
        if (type === 'tp') {
          const keys = ((D.team_pos[team] || {})[pos]) || [];
          const cands = keys.map(k => ({ key: k, name: name(k), fame: fame(k) })).sort((a, b) => b.fame - a.fame);
          return send(200, { question: keys.length ? `Name a ${pos} who played for the ${D.teams[team]}` : null, tiers: heuristicTiers(cands), n: cands.length });
        }
        if (type === 'tn') {
          const keys = ((D.team_num[team] || {})[String(num)]) || [];
          const cands = keys.map(k => ({ key: k, name: name(k), fame: fame(k) })).sort((a, b) => b.fame - a.fame);
          return send(200, { question: keys.length ? `Name a player who wore #${num} for the ${D.teams[team]}` : null, tiers: heuristicTiers(cands), n: cands.length });
        }
        if (type === 'player') {
          const hits = Object.entries(D.players).filter(([, v]) => norm(v.name).includes(norm(query))).slice(0, 12).map(([k, v]) => ({
            name: v.name, fame: v.fame, teams: Object.entries(v.teams).map(([t, x]) => `${t} ${x.first}-${x.last} (${x.n}yr)`),
          }));
          return send(200, { hits });
        }
        return send(400, { error: 'bad type' });
      }
      if (p === '/api/feasibility') {
        const team = (url.searchParams.get('team') || '').toUpperCase() || null;
        const f = arr => team ? arr.filter(q => q.team === team || (q.tenures && q.tenures.some(t => t.team === team))) : arr;
        const poolsF = { tp: f(pool.tp), tn: f(pool.tn), mt: f(pool.mt) };
        const stat = arr => {
          if (!arr.length) return { count: 0, min: 0, avg: 0, max: 0 };
          const sizes = arr.map(q => q.cands ? q.cands.length : q.tenures.length);
          return { count: arr.length, min: Math.min(...sizes), avg: +(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1), max: Math.max(...sizes) };
        };
        const examples = m => ({ tp: poolsF.tp[Math.floor(poolsF.tp.length / 2)], tn: poolsF.tn[Math.floor(poolsF.tn.length / 2)], mt: poolsF.mt[Math.floor(poolsF.mt.length / 2)] }[m]);
        const ex = { tp: examples('tp'), tn: examples('tn'), mt: examples('mt') };
        return send(200, {
          coverage: D.coverage, players: Object.keys(D.players).length, team, teams: D.teams,
          pools: { tp: stat(poolsF.tp), tn: stat(poolsF.tn), mt: stat(poolsF.mt) },
          examples: {
            tp: ex.tp ? ex.tp.cands.slice(0, 8).map(c => `${c.name} (${c.fame})`) : [],
            tn: ex.tn ? ex.tn.cands.slice(0, 8).map(c => `${c.name} (${c.fame})`) : [],
            mt: ex.mt ? ex.mt.player : null,
          },
        });
      }
      if (p === '/api/jevkey') {
        const { key } = body;
        jevKey = (key || '').trim() || null;
        if (jevKey) fs.writeFileSync(KEY_PATH, jevKey); else { try { fs.unlinkSync(KEY_PATH); } catch {} }
        return send(200, { configured: !!jevKey });
      }
      if (p === '/api/jevstatus') {
        if (!jevKey) return send(200, { configured: false, model: JEV_MODEL });
        try {
          const r = await jev([{ role: 'user', content: 'Reply with JSON {"ok":true}' }], 50);
          return send(200, { configured: true, model: JEV_MODEL, live: r.ok === true });
        } catch (e) { return send(200, { configured: true, model: JEV_MODEL, error: e.message }); }
      }
      if (p === '/api/jevtier') {
        const { mode, qid } = body;
        const poolArr = { tp: pool.tp, tn: pool.tn, mt: pool.mt }[mode] || [];
        const q = poolArr.find(q => q.id === qid);
        if (!q) return send(400, { error: 'bad qid' });
        const heuristic = q.cands ? heuristicTiers(q.cands) : null;
        if (!jevKey) return send(200, { source: 'heuristic', tiers: heuristic });
        try {
          const out = await jevTier(q);
          const tiers = q.cands.map(c => ({ ...c, tier: (out.tiers && (out.tiers[c.name] || out.tiers[c.name.trim()])) || 'uncommon' }));
          return send(200, { source: 'jev', tiers });
        } catch (e) { return send(200, { source: 'heuristic', error: e.message, tiers: heuristic }); }
      }
      if (p === '/api/game/start') {
        const g = newGame((body.team || '').toUpperCase() || null);
        return send(200, gameView(g));
      }
      if (p === '/api/game/answer') {
        const g = GAMES.get(body.gameId);
        if (!g) return send(400, { error: 'no such game' });
        const out = await gameAnswer(g, body.answer || '');
        return send(200, out);
      }
      if (p === '/api/game/kick') {
        const g = GAMES.get(body.gameId);
        if (!g) return send(400, { error: 'no such game' });
        const out = gameKick(g);
        return send(200, out);
      }
      return send(404, { error: 'not found' });
    }
    // static — HTML must revalidate (fixes stale-cache bugs on iOS), dataset can cache hard
    let fp = path.join(ROOT, 'public', p === '/' ? 'index.html' : p.replace(/\.\./g, ''));
    if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp = path.join(ROOT, 'public', 'index.html');
    const ext = path.extname(fp);
    let body = fs.readFileSync(fp);
    if (ext === '.html') body = Buffer.from(fs.readFileSync(fp, 'utf8').replace('@@ENV@@', process.env.NODE_ENV || 'development'));
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.json' ? 'public, max-age=86400' : 'no-cache',
    });
    res.end(body);
  } catch (e) {
    try { send(500, { error: e.message }); } catch {}
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Deep Bench on http://127.0.0.1:${PORT}`));
