// Deep Bench game core — pure, portable, zero-dependency.
// Runs identically in Node (demo server) and Cloudflare Workers.
// Nothing here touches http/fs/state stores: the host injects `adjudicate`
// (long-tail jev verdicts) and owns persistence of the plain-JSON state.

const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

// heuristic tier from fame ranks within a candidate pool (fame desc order)
function heuristicTiers(cands) {
  const n = cands.length;
  return cands.map((c, i) => {
    const f = n === 1 ? 0 : i / (n - 1); // 0 = most famous
    const tier = f < 0.22 ? 'common' : f < 0.55 ? 'uncommon' : f < 0.85 ? 'rare' : 'deep';
    return { ...c, tier };
  });
}

function matchCandidate(q, answer) {
  const a = norm(answer);
  if (!a) return null;
  const cands = q.cands || [];
  for (const c of cands) if (norm(c.name) === a) return c;
  for (const c of cands) {
    const cn = norm(c.name);
    if (cn.endsWith(' ' + a) || cn === a) return c; // last-name match
  }
  // fuzzy: typo tolerance against last names
  for (const c of cands) {
    const last = norm(c.name).split(' ').pop();
    if (last.length >= 5 && lev(a, last) <= (a.length > 6 ? 2 : 1)) return c;
  }
  return null;
}

const TIER_POINTS = { common: 10, uncommon: 50, rare: 100, deep: 200 };
const YARDAGE = { deep: 14, rare: 12, uncommon: 9, common: 6 };
const DRIVE_START = 25; // own 25
const KICK_ODDS = d => d <= 29 ? 0.96 : d <= 34 ? 0.92 : d <= 39 ? 0.86 : d <= 44 ? 0.78 : d <= 49 ? 0.70 : d <= 54 ? 0.55 : d <= 59 ? 0.40 : 0.12;

function createGame(D, opts = {}) {
  const adjudicate = opts.adjudicate || null; // async (q, answer) => {valid, tier, note} | null
  const today = opts.today || (() => new Date().toISOString().slice(0, 10));

  const name = k => D.players[k].name;
  const fame = k => D.players[k].fame;

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

  function qPrompt(q) {
    switch (q.mode) {
      case 'tp': return `Name any player who has played ${q.pos} for the ${D.teams[q.team]} at any point in franchise history.`;
      case 'tn': return `Name any player who has worn jersey number #${q.num} for the ${D.teams[q.team]} at any point in franchise history.`;
      case 'mt': return `${q.player} played for ${q.tenures.length} NFL teams. Which one did he spend the FEWEST seasons with?`;
    }
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

  // grade one answer against one question — no side effects, no pulses
  function gradeQuestion(q, answer) {
    const m = q.mode === 'mt' ? matchMT(q, answer) : matchCandidate(q, answer);
    if (!m) return { status: 'not_found', note: q.mode === 'mt'
      ? 'Doesn\'t match any of his teams — recall another stint and try again.'
      : 'Answer not in roster database (2002+).' };
    if (q.mode !== 'mt' && !m.tier) {
      const t = heuristicTiers(q.cands).find(x => x.key === m.key);
      m.tier = t ? t.tier : 'uncommon';
    }
    return { status: 'ok', answer: m.name, tier: m.tier, points: TIER_POINTS[m.tier] };
  }

  // daily deterministic selection — same questions for everyone on a date
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

  // ---------- drive state (plain JSON, serializable) ----------
  function pickN(list, n) {
    const c = [...list];
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c.slice(0, n);
  }

  function newState({ id, team }) {
    const f = arr => {
      const filtered = team ? arr.filter(q => q.team === team) : arr;
      return filtered.length ? filtered : arr;
    };
    // mixed bag: 2-3 position questions + the rest number questions
    const tpN = 2 + Math.floor(Math.random() * 2);
    const qs = [...pickN(f(pool.tp), tpN), ...pickN(f(pool.tn), 5 - tpN)];
    const order = qs.sort(() => Math.random() - 0.5);
    return { id, team: team || null, questions: order, idx: 0, yards: 0, log: [], status: 'active' };
  }

  function view(state) {
    return {
      gameId: state.id, team: state.team, idx: state.idx, total: state.questions.length,
      status: state.status, yards: state.yards,
      ballAt: Math.min(99, DRIVE_START + state.yards),
      log: state.log,
      question: state.status === 'active' ? { id: state.questions[state.idx].id, mode: state.questions[state.idx].mode, prompt: qPrompt(state.questions[state.idx]) } : null,
    };
  }

  // apply an answer to the state (mutates), grading via DB then long-tail
  async function answer(state, answerStr) {
    if (state.status !== 'active') return { error: 'drive not active' };
    const q = state.questions[state.idx];
    let r = gradeQuestion(q, answerStr);
    if (r.status !== 'ok' && adjudicate) {
      try {
        const v = await adjudicate(q, answerStr);
        if (v && v.valid) r = { status: 'ok', answer: answerStr, tier: v.tier, points: TIER_POINTS[v.tier], source: 'jev', note: v.note };
        else if (v) r = { status: 'wrong', source: 'jev', note: v.note };
      } catch (e) {
        r = { ...r, note: (r.note || '') + ' (jev unavailable: ' + e.message + ')' };
      }
    }
    let gained = 0, tier = null, shown = answerStr;
    if (r.status === 'ok') {
      tier = r.tier; gained = YARDAGE[tier]; shown = r.answer;
      state.yards += gained;
    }
    state.log.push({ n: state.idx + 1, mode: q.mode, answer: shown, tier: tier || 'miss', gained, source: r.source || 'db', note: r.note || null });
    state.idx++;
    let fg = null;
    if (state.idx >= state.questions.length) {
      state.status = 'kick';
      const dist = fgDistance(state);
      fg = { dist, prob: Math.round(KICK_ODDS(dist) * 100) };
    }
    return { verdict: { tier: tier || 'miss', gained, note: r.note || null, answer: shown, status: r.status, source: r.source || 'db' }, fg };
  }

  function fgDistance(state) { return (100 - (DRIVE_START + state.yards)) + 17; }

  function kick(state) {
    if (state.status !== 'kick') return { error: 'not in kick phase' };
    const dist = fgDistance(state);
    const prob = KICK_ODDS(dist);
    const made = Math.random() < prob;
    state.status = 'done';
    state.log.push({ n: 'K', mode: 'kick', answer: `${dist}-yard field goal`, tier: made ? 'made' : 'missed', gained: 0, made });
    return { kick: { dist, prob: Math.round(prob * 100), made, points: made ? 3 : 0 } };
  }

  return {
    teams: D.teams,
    coverage: D.coverage,
    pools: pool,
    norm, mulberry32, heuristicTiers, matchCandidate, qPrompt, gradeQuestion, pickDaily,
    tierPoints: TIER_POINTS, yardage: YARDAGE, kickOdds: KICK_ODDS,
    newState, view, answer, kick,
    today,
  };
}

module.exports = { createGame, norm, heuristicTiers, TIER_POINTS, YARDAGE, DRIVE_START, KICK_ODDS, mulberry32 };
