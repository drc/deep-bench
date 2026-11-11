// Deep Bench — Cloudflare Worker.
// Uses the same pure game core as the Node demo (lib/game.js).
// Persistence: D1 (players, games, answers, daily_picks, jev verdict cache).
import dataset from '../public/dataset.json';
import htmlSrc from '../public/index.html';
import ogImage from '../public/og.jpg';
import { createGame } from '../lib/game';
import { verifyPlayerId, cookieFor } from './auth';

const G = createGame(dataset);
const JEVTIER_SYSTEM = 'You rank NFL player name popularity among typical NFL fans. Respond ONLY with JSON: {"tiers": {"<exact player name>": "common"|"uncommon"|"rare"|"deep"}}. common = most fans name them quickly; uncommon = seasoned fans; rare = dedicated fans; deep = deepest-cut, only superfans name them.';
const JUDGE_SYSTEM = 'You are an NFL trivia judge. You know NFL rosters and history precisely. Respond ONLY with JSON: {"valid": boolean, "tier": "common"|"uncommon"|"rare"|"deep", "note": string}. valid = the named player/answer actually satisfies the question. tier = how likely a typical NFL fan is to give this same answer: common (most people), uncommon (seasoned fans), rare (dedicated fans), deep (deepest-cut knowledge — only die-hard superfans or historians would name it).';

// ---------- helpers ----------
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function recap(state) {
  const icon = { deep: '🟡', rare: '🟣', uncommon: '🔵', common: '🟠', miss: '🔴' };
  const plays = (state.log || []).filter(l => l.mode !== 'kick').map(l => icon[l.tier] || '⚪').join('');
  const kickEntry = (state.log || []).find(l => l.mode === 'kick');
  const made = kickEntry ? kickEntry.made : null;
  const points = made == null ? 0 : made ? 3 : 0;
  return { yards: state.yards, plays, made, points, status: state.status };
}

// ---------- identity ----------
async function requirePlayer(env, request) {
  const uid = await verifyPlayerId(request.headers.get('Cookie') || '', env.COOKIE_SECRET);
  let id, setCookie = null;
  if (uid) {
    id = uid;
  } else {
    id = crypto.randomUUID();
    setCookie = await cookieFor(id, env.COOKIE_SECRET);
  }
  await env.DB.prepare('INSERT OR IGNORE INTO players (id, created_at) VALUES (?, ?)').bind(id, new Date().toISOString()).run();
  return { playerId: id, setCookie };
}

// ---------- jev router (verdict cache in D1) ----------
async function adjudicateFor(env) {
  if (!env.OPENROUTER_API_KEY) return null;
  return async (q, answer) => {
    const key = `${q.id}|${answer.toLowerCase().trim()}`;
    const hit = await env.DB.prepare('SELECT value FROM verdicts WHERE cache_key = ?').bind(key).first();
    if (hit) return JSON.parse(hit.value);
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({
        model: 'typesafe/jev-router',
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: `Question: ${G.qPrompt(q)}\nProposed answer: ${answer}\nJudge it.` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`jev ${res.status}`);
    const out = JSON.parse((await res.json()).choices[0].message.content);
    await env.DB.prepare('INSERT OR IGNORE INTO verdicts (cache_key, value, created_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(out), new Date().toISOString()).run();
    return out;
  };
}

// ---------- routes ----------
async function handleStart(env, request) {
  const { playerId, setCookie } = await requirePlayer(env, request);
  const date = G.today();
  const body = await request.json().catch(() => ({}));
  const team = typeof body.team === 'string' && G.teams[body.team.toUpperCase()] ? body.team.toUpperCase() : null;
  const existing = await env.DB.prepare('SELECT state, points FROM games WHERE player_id = ? AND game_date = ?').bind(playerId, date).first();
  const headers = setCookie ? { 'Set-Cookie': setCookie } : {};
  if (existing) {
    const state = JSON.parse(existing.state);
    // abandoned drives resume where you left off; only finished drives block a new one
    if (state.status !== 'done') {
      const view = G.view(state);
      if (state.status === 'kick') view.fg = G.fgPreview(state);
      return json({ ...view, date }, 200, headers);
    }
    const r = recap(state);
    return json({ alreadyPlayed: true, date, recap: r, points: existing.points }, 409, headers);
  }
  const state = G.newState({ id: crypto.randomUUID(), team });
  // daily snapshot record — the first drive's question set of the day
  await env.DB.prepare('INSERT OR IGNORE INTO daily_picks (game_date, qids, created_at) VALUES (?, ?, ?)')
    .bind(date, JSON.stringify(state.questions.map(q => q.id)), new Date().toISOString()).run();
  await env.DB.prepare('INSERT INTO games (player_id, game_date, status, yards, points, state) VALUES (?, ?, ?, 0, 0, ?)')
    .bind(playerId, date, 'active', JSON.stringify(state)).run();
  // flat view at top level — same shape as the Node demo's /api/game/start
  return json({ ...G.view(state), date }, 200, headers);
}

async function handleAnswer(env, request, body) {
  const { playerId, setCookie } = await requirePlayer(env, request);
  const date = G.today();
  const row = await env.DB.prepare('SELECT state FROM games WHERE player_id = ? AND game_date = ?').bind(playerId, date).first();
  if (!row) return json({ error: 'no game for today — start one first' }, 400, setCookie ? { 'Set-Cookie': setCookie } : {});
  const state = JSON.parse(row.state);
  const out = await G.answer(state, body.answer || '', { adjudicate: await adjudicateFor(env) });
  if (out.error) return json(out);
  await env.DB.prepare('UPDATE games SET state = ?, status = ?, yards = ? WHERE player_id = ? AND game_date = ?')
    .bind(JSON.stringify(state), state.status, state.yards, playerId, date).run();
  const last = state.log[state.log.length - 1];
  await env.DB.prepare('INSERT OR REPLACE INTO answers (player_id, game_date, play, qid, answer, tier, yards, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(playerId, date, last.n, state.questions[Math.min(state.idx, state.questions.length) - 1].id, last.answer, last.tier, last.gained, last.source).run();
  return json({ view: G.view(state), verdict: out.verdict, ...(out.fg ? { fg: out.fg } : {}) });
}

async function handleKick(env, request) {
  const { playerId } = await requirePlayer(env, request);
  const date = G.today();
  const row = await env.DB.prepare('SELECT state FROM games WHERE player_id = ? AND game_date = ?').bind(playerId, date).first();
  if (!row) return json({ error: 'no game for today' }, 400);
  const state = JSON.parse(row.state);
  const out = G.kick(state);
  if (out.error) return json(out);
  await env.DB.prepare('UPDATE games SET state = ?, status = ?, points = ? WHERE player_id = ? AND game_date = ?')
    .bind(JSON.stringify(state), state.status, out.kick.points, playerId, date).run();
  return json({ view: G.view(state), kick: out.kick });
}

async function handleMe(env, request) {
  const { playerId, setCookie } = await requirePlayer(env, request);
  const date = G.today();
  const today = await env.DB.prepare('SELECT status, yards, points, state FROM games WHERE player_id = ? AND game_date = ?').bind(playerId, date).first();
  const history = await env.DB.prepare('SELECT game_date, yards, points, status FROM games WHERE player_id = ? ORDER BY game_date DESC LIMIT 60')
    .bind(playerId).all();
  let todayState = null;
  if (today && today.state) todayState = recap(JSON.parse(today.state));
  return json({
    playerId, date,
    today: today ? { status: today.status, yards: today.yards, points: today.points, recap: todayState } : null,
    history: history.results || [],
  }, 200, setCookie ? { 'Set-Cookie': setCookie } : {});
}

async function handleFeasibility(request) {
  const url = new URL(request.url);
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
  return json({
    coverage: G.coverage, players: Object.keys(dataset.players).length, team, teams: G.teams,
    pools: { tp: stat(poolsF.tp), tn: stat(poolsF.tn), mt: stat(poolsF.mt) },
    examples: {
      tp: ex.tp ? ex.tp.cands.slice(0, 8).map(c => `${c.name} (${c.fame})`) : [],
      tn: ex.tn ? ex.tn.cands.slice(0, 8).map(c => `${c.name} (${c.fame})`) : [],
      mt: ex.mt ? ex.mt.player : null,
    },
  });
}

function handleLookup(request) {
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const team = (url.searchParams.get('team') || '').toUpperCase();
  const pos = (url.searchParams.get('pos') || '').toUpperCase();
  const num = url.searchParams.get('num');
  const query = url.searchParams.get('q') || '';
  if (type === 'tp' || type === 'tn') {
    const idx = type === 'tp' ? dataset.team_pos : dataset.team_num;
    const keys = type === 'tp' ? ((idx[team] || {})[pos]) || [] : ((idx[team] || {})[String(num)]) || [];
    const cands = keys.map(k => ({ key: k, name: dataset.players[k].name, fame: dataset.players[k].fame })).sort((a, b) => b.fame - a.fame);
    const question = keys.length
      ? (type === 'tp' ? `Name a ${pos} who played for the ${G.teams[team]}` : `Name a player who wore #${num} for the ${G.teams[team]}`)
      : null;
    return json({ question, tiers: G.heuristicTiers(cands), n: cands.length });
  }
  if (type === 'player') {
    const hits = Object.entries(dataset.players).filter(([, v]) => G.norm(v.name).includes(G.norm(query))).slice(0, 12).map(([k, v]) => ({
      name: v.name, fame: v.fame, teams: Object.entries(v.teams).map(([t, x]) => `${t} ${x.first}-${x.last} (${x.n}yr)`),
    }));
    return json({ hits });
  }
  return json({ error: 'bad type' }, 400);
}

// ---------- entry ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (!env.COOKIE_SECRET) return json({ error: 'COOKIE_SECRET not set — run: wrangler secret put COOKIE_SECRET (or create .dev.vars for local dev)' }, 500);
      if (request.method === 'POST' && p === '/api/game/start') return await handleStart(env, request);
      if (request.method === 'POST' && p === '/api/game/answer') return await handleAnswer(env, request, await request.json());
      if (request.method === 'POST' && p === '/api/game/kick') return await handleKick(env, request);
      if (request.method === 'GET' && p === '/api/me') return await handleMe(env, request);
      if (request.method === 'GET' && p === '/api/feasibility') return await handleFeasibility(request);
      if (request.method === 'GET' && p === '/api/lookup') return handleLookup(request);
      if (request.method === 'GET' && p === '/og.jpg') {
        return new Response(ogImage, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } });
      }
      if (request.method === 'GET' && (p === '/' || !p.startsWith('/api/'))) {
        // @@ORIGIN@@ keeps og:url / og:image absolute and correct on any host
        const html = htmlSrc.replace('@@ENV@@', 'production').replaceAll('@@ORIGIN@@', url.origin);
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
