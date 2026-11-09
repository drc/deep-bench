// Deep Bench — NFL rarity trivia demo server (zero deps)
// The pure game core lives in lib/game.js (shared with the Cloudflare Worker).
// This file owns transport, in-memory state, pulses, and the jev key/cache.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createGame, norm } = require('./lib/game');

const ROOT = __dirname;
const PORT = process.env.PORT || 4310;
const JEV_MODEL = 'typesafe/jev-router';

const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'dataset.json'), 'utf8'));
const JEV_CACHE_PATH = path.join(ROOT, 'data', 'jev-cache.json');
const KEY_PATH = path.join(ROOT, 'data', '.jevkey');
let jevKey = process.env.OPENROUTER_API_KEY || (fs.existsSync(KEY_PATH) ? fs.readFileSync(KEY_PATH, 'utf8').trim() : null);
let jevCache = fs.existsSync(JEV_CACHE_PATH) ? JSON.parse(fs.readFileSync(JEV_CACHE_PATH, 'utf8')) : {};

// ---------- jev transport (Node-specific; the Worker will inject its own) ----------
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

async function jevAdjudicate(q, answer) {
  const cacheKey = `${q.id}|${norm(answer)}`;
  if (jevCache[cacheKey]) return jevCache[cacheKey];
  const out = await jev([
    { role: 'system', content: 'You are an NFL trivia judge. You know NFL rosters and history precisely. Respond ONLY with JSON: {"valid": boolean, "tier": "common"|"uncommon"|"rare"|"deep", "note": string}. valid = the named player/answer actually satisfies the question. tier = how likely a typical NFL fan is to give this same answer: common (most people), uncommon (seasoned fans), rare (dedicated fans), deep (deepest-cut knowledge — only die-hard superfans or historians would name it).' },
    { role: 'user', content: `Question: ${G.qPrompt(q)}\nProposed answer: ${answer}\nJudge it.` },
  ], 300);
  jevCache[cacheKey] = out;
  try { fs.writeFileSync(JEV_CACHE_PATH, JSON.stringify(jevCache)); } catch {}
  return out;
}

async function jevTier(q) {
  if (jevCache['tier|' + q.id]) return jevCache['tier|' + q.id];
  const list = q.cands ? q.cands.map(c => c.name) : null;
  const out = await jev([
    { role: 'system', content: 'You rank NFL player name popularity among typical NFL fans. Respond ONLY with JSON: {"tiers": {"<exact player name>": "common"|"uncommon"|"rare"|"deep"}}. common = most fans name them quickly; uncommon = seasoned fans; rare = dedicated fans; deep = deepest-cut, only superfans name them.' },
    { role: 'user', content: `Question: ${G.qPrompt(q)}\nCandidate answers:\n${list.map(n => '- ' + n).join('\n')}\nAssign a tier to each.` },
  ], 2000);
  jevCache['tier|' + q.id] = out;
  try { fs.writeFileSync(JEV_CACHE_PATH, JSON.stringify(jevCache)); } catch {}
  return out;
}

// ---------- game core ----------
const G = createGame(D, {
  // dynamic: respects /api/jevkey changes at runtime; null => DB-only grading
  adjudicate: (q, answer) => (jevKey ? jevAdjudicate(q, answer) : Promise.resolve(null)),
});

const GAMES = new Map();
const pulses = {}; // "date|qid|normAnswer" -> count (demo-only distribution tracking)

function recordPulse(dateStr, qid, shownAnswer) {
  const key = `${dateStr}|${qid}|${norm(shownAnswer)}`;
  pulses[key] = (pulses[key] || 0) + 1;
  const total = Object.entries(pulses).filter(([k]) => k.startsWith(`${dateStr}|${qid}|`)).reduce((a, [, v]) => a + v, 0);
  return { picked: pulses[key], pickedPct: Math.round((pulses[key] / total) * 100), totalAnswers: total };
}

// grade + long-tail jev path, shared by /api/grade and the drive
async function gradeWithJev(q, answer) {
  const direct = G.gradeQuestion(q, answer);
  if (direct.status === 'ok' || !jevKey) return direct;
  try {
    const verdict = await jevAdjudicate(q, answer);
    if (verdict.valid) return { status: 'ok', answer, tier: verdict.tier, points: G.tierPoints[verdict.tier], source: 'jev', note: verdict.note };
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
        const qs = G.pickDaily(date, team);
        return send(200, {
          date, team, coverage: G.coverage, teams: G.teams, counts: qs.counts,
          questions: {
            tp: { ...qs.tp, prompt: G.qPrompt(qs.tp), cands: undefined },
            tn: { ...qs.tn, prompt: G.qPrompt(qs.tn), cands: undefined },
            mt: { ...qs.mt, prompt: G.qPrompt(qs.mt), tenures: undefined },
          },
        });
      }
      if (p === '/api/grade') {
        const { mode, qid, answer, date } = body;
        const poolArr = G.pools[mode] || [];
        const q = poolArr.find(q => q.id === qid);
        if (!q) return send(400, { error: 'bad qid' });
        const d = date || new Date().toISOString().slice(0, 10);
        const r = await gradeWithJev(q, answer);
        if (r.status === 'ok') return send(200, { ...r, ...recordPulse(d, q.id, r.answer) });
        return send(200, { ...r, note: mode === 'mt'
          ? r.note
          : r.note + (jevKey ? '' : ' Set a jev key in Settings to adjudicate long-tail answers like this.') });
      }
      if (p === '/api/lookup') {
        const type = url.searchParams.get('type');
        const team = (url.searchParams.get('team') || '').toUpperCase();
        const pos = (url.searchParams.get('pos') || '').toUpperCase();
        const num = url.searchParams.get('num');
        const query = url.searchParams.get('q') || '';
        if (type === 'tp' || type === 'tn') {
          const idx = type === 'tp' ? D.team_pos : D.team_num;
          const keys = type === 'tp' ? ((idx[team] || {})[pos]) || [] : ((idx[team] || {})[String(num)]) || [];
          const cands = keys.map(k => ({ key: k, name: D.players[k].name, fame: D.players[k].fame })).sort((a, b) => b.fame - a.fame);
          const question = keys.length
            ? (type === 'tp' ? `Name a ${pos} who played for the ${G.teams[team]}` : `Name a player who wore #${num} for the ${G.teams[team]}`)
            : null;
          return send(200, { question, tiers: G.heuristicTiers(cands), n: cands.length });
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
        const poolsF = { tp: f(G.pools.tp), tn: f(G.pools.tn), mt: f(G.pools.mt) };
        const stat = arr => {
          if (!arr.length) return { count: 0, min: 0, avg: 0, max: 0 };
          const sizes = arr.map(q => q.cands ? q.cands.length : q.tenures.length);
          return { count: arr.length, min: Math.min(...sizes), avg: +(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(1), max: Math.max(...sizes) };
        };
        const pick = a => a[Math.floor(a.length / 2)];
        const ex = { tp: pick(poolsF.tp), tn: pick(poolsF.tn), mt: pick(poolsF.mt) };
        return send(200, {
          coverage: G.coverage, players: Object.keys(D.players).length, team, teams: G.teams,
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
        const q = (G.pools[mode] || []).find(q => q.id === qid);
        if (!q) return send(400, { error: 'bad qid' });
        const heuristic = q.cands ? G.heuristicTiers(q.cands) : null;
        if (!jevKey) return send(200, { source: 'heuristic', tiers: heuristic });
        try {
          const out = await jevTier(q);
          const tiers = q.cands.map(c => ({ ...c, tier: (out.tiers && (out.tiers[c.name] || out.tiers[c.name.trim()])) || 'uncommon' }));
          return send(200, { source: 'jev', tiers });
        } catch (e) { return send(200, { source: 'heuristic', error: e.message, tiers: heuristic }); }
      }
      if (p === '/api/game/start') {
        const state = G.newState({ id: Math.random().toString(36).slice(2, 10), team: (body.team || '').toUpperCase() || null });
        GAMES.set(state.id, state);
        return send(200, G.view(state));
      }
      if (p === '/api/game/answer') {
        const state = GAMES.get(body.gameId);
        if (!state) return send(400, { error: 'no such game' });
        const out = await G.answer(state, body.answer || '');
        if (out.error) return send(200, out);
        return send(200, { view: G.view(state), verdict: out.verdict, ...(out.fg ? { fg: out.fg } : {}) });
      }
      if (p === '/api/game/kick') {
        const state = GAMES.get(body.gameId);
        if (!state) return send(400, { error: 'no such game' });
        const out = G.kick(state);
        if (out.error) return send(200, out);
        return send(200, { view: G.view(state), kick: out.kick });
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
