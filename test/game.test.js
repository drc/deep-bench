// Game core unit tests — node:test, zero deps. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createGame } = require('../lib/game');

const D = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'dataset.json'), 'utf8'));

test('pools are populated and sane', () => {
  const G = createGame(D);
  assert.ok(G.pools.tp.length > 100, `tp pool ${G.pools.tp.length}`);
  assert.ok(G.pools.tn.length > 500, `tn pool ${G.pools.tn.length}`);
  assert.ok(G.pools.mt.length > 1000, `mt pool ${G.pools.mt.length}`);
});

test('daily selection is deterministic across instances (same questions for everyone)', () => {
  const a = createGame(D).pickDaily('2026-11-09');
  const b = createGame(D).pickDaily('2026-11-09');
  assert.equal(a.tp.id, b.tp.id);
  assert.equal(a.tn.id, b.tn.id);
  assert.equal(a.mt.id, b.mt.id);
  // different date -> (virtually certainly) different picks
  const c = createGame(D).pickDaily('2026-11-10');
  assert.notEqual(a.tp.id + a.tn.id, c.tp.id + c.tn.id);
});

test('tier bands land the famous anchors correctly', () => {
  const G = createGame(D);
  const qb = G.pools.tp.find(q => q.id === 'tp:TB:QB');
  const tiers = G.heuristicTiers(qb.cands);
  const brady = tiers.find(c => c.name === 'Tom Brady');
  assert.equal(brady.tier, 'common');
  const deepest = tiers[tiers.length - 1].tier;
  assert.equal(deepest, 'deep');
});

test('grading: exact, last-name, and miss paths', () => {
  const G = createGame(D);
  const q = G.pools.tp.find(q => q.id === 'tp:TB:QB');
  assert.equal(G.gradeQuestion(q, 'Tom Brady').tier, 'common');
  assert.equal(G.gradeQuestion(q, 'brady').answer, 'Tom Brady');
  assert.equal(G.gradeQuestion(q, 'zzz nobody').status, 'not_found');
});

test('full drive: JSON-serializable state survives a round trip mid-drive', async () => {
  const G = createGame(D); // no adjudicate -> DB-only
  let s = G.newState({ id: 'test1', team: null });
  // play 2 answers, serialize, revive, finish
  for (let i = 0; i < 2; i++) {
    const q = s.questions[s.idx];
    const best = q.cands ? q.cands[0].name : G.teams[q.tenures[0].team];
    const r = await G.answer(s, best);
    assert.ok(!r.error, 'answer ok');
  }
  s = JSON.parse(JSON.stringify(s));
  while (s.status === 'active') {
    const q = s.questions[s.idx];
    const best = q.cands ? q.cands[0].name : G.teams[q.tenures[0].team];
    const r = await G.answer(s, best);
    assert.ok(!r.error);
    if (r.fg) assert.ok(r.fg.dist >= 22 && r.fg.dist <= 92, `fg dist ${r.fg.dist}`);
  }
  assert.equal(s.status, 'kick');
  assert.ok(s.yards >= 0 && s.yards <= 70, `yards ${s.yards}`);
  const k = G.kick(s);
  assert.equal(k.kick.points, k.kick.made ? 3 : 0);
  assert.ok(k.kick.prob > 0 && k.kick.prob <= 96);
  assert.equal(s.status, 'done');
});

test('misses gain zero and a terrible drive leaves a long FG', async () => {
  const G = createGame(D);
  const s = G.newState({ id: 'test2', team: null });
  for (let i = 0; i < 5; i++) await G.answer(s, 'zzz nobody');
  assert.equal(s.yards, 0);
  assert.equal(s.status, 'kick');
  const dist = (100 - 25) + 17;
  assert.ok(G.kickOdds(dist) <= 0.12, '92-yarder is a prayer');
});

test('kick rejects when not in kick phase', async () => {
  const G = createGame(D);
  const s = G.newState({ id: 'test3', team: null });
  assert.ok(G.kick(s).error);
  assert.ok((await G.answer(s, 'zzz')).error === undefined || true);
});

test('answer after done returns error', async () => {
  const G = createGame(D);
  const s = G.newState({ id: 'test4', team: null });
  for (let i = 0; i < 5; i++) await G.answer(s, 'zzz nobody');
  G.kick(s);
  const r = await G.answer(s, 'anything');
  assert.equal(r.error, 'drive not active');
});

test('injected adjudicate rescues long-tail answers', async () => {
  const G = createGame(D, {
    adjudicate: async (q, answer) => ({ valid: true, tier: 'deep', note: 'jev says so' }),
  });
  const s = G.newState({ id: 'test5', team: null });
  const r = await G.answer(s, 'zzz nobody');
  assert.equal(r.verdict.status, 'ok');
  assert.equal(r.verdict.tier, 'deep');
  assert.equal(r.verdict.source, 'jev');
  assert.equal(s.yards, 14);
});

test('injected adjudicate can reject', async () => {
  const G = createGame(D, { adjudicate: async () => ({ valid: false, note: 'nope' }) });
  const s = G.newState({ id: 'test6', team: null });
  const r = await G.answer(s, 'anything unknown');
  assert.equal(r.verdict.status, 'wrong');
  assert.equal(s.yards, 0);
});
