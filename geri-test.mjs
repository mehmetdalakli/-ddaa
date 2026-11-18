// Geçmiş testi: uygulamadaki modelin geçmiş sezonlarda nasıl sonuç vereceğini ölçer.
// Veri: football-data.co.uk (ücretsiz CSV: sonuçlar + bahis oranları). Çıktı: data/backtest.json
import fs from 'fs';

const LEAGUES = { 'tur.1': 'T1', 'eng.1': 'E0', 'eng.2': 'E1', 'esp.1': 'SP1', 'ita.1': 'I1', 'ger.1': 'D1', 'fra.1': 'F1', 'ned.1': 'N1', 'por.1': 'P1', 'bel.1': 'B1' };
const NAMES = { 'tur.1': 'Süper Lig', 'eng.1': 'Premier League', 'eng.2': 'Championship', 'esp.1': 'La Liga', 'ita.1': 'Serie A', 'ger.1': 'Bundesliga', 'fra.1': 'Ligue 1', 'ned.1': 'Eredivisie', 'por.1': 'Portekiz', 'bel.1': 'Belçika' };
const DAY = 864e5, HL = 45, K = 3, RHO = -0.05, WINDOW = 200 * DAY;
const WS = [0, 0.25, 0.5, 0.6, 0.75, 0.9];
const EVS = [0.03, 0.05, 0.08, 0.12];
const CAP = 1.04; // uygulamadaki gibi: en yüksek oran, ortalamanın en fazla %4 üstü
const now = new Date();
const curStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
const code = y => String(y % 100).padStart(2, '0') + String((y + 1) % 100).padStart(2, '0');
const SEASONS = [curStart - 3, curStart - 2, curStart - 1, curStart].map(code); // ilki sadece ısınma
const BET_FROM = SEASONS[1];
const SRC = process.env.FD_DIR || null; // test için yerel klasör

// ---------- yardımcılar ----------
function pois(k, l) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function dcProbs(lh, la, rho) {
  const N = 8, ph = [], pa = []; for (let i = 0; i <= N; i++) { ph[i] = pois(i, lh); pa[i] = pois(i, la); }
  let h = 0, d = 0, a = 0, o = 0, t = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    let p = ph[i] * pa[j];
    if (i === 0 && j === 0) p *= 1 - lh * la * rho; else if (i === 0 && j === 1) p *= 1 + lh * rho; else if (i === 1 && j === 0) p *= 1 + la * rho; else if (i === 1 && j === 1) p *= 1 - rho;
    t += p; if (i > j) h += p; else if (i === j) d += p; else a += p; if (i + j > 2.5) o += p;
  }
  return { h: h / t, d: d / t, a: a / t, o25: o / t };
}
function impliedLambdas(q, rho) {
  const err = (x, y) => { const r = dcProbs(x, y, rho); let e = (r.h - q.h) ** 2 + (r.d - q.d) ** 2 + (r.a - q.a) ** 2; if (q.o25 != null) e += (r.o25 - q.o25) ** 2; return e; };
  let bx = 1.4, by = 1.1, be = Infinity;
  for (let x = .2; x <= 4.21; x += .15) for (let y = .2; y <= 4.21; y += .15) { const e = err(x, y); if (e < be) { be = e; bx = x; by = y; } }
  for (const s of [.05, .015]) { const cx = bx, cy = by; for (let x = cx - 3 * s; x <= cx + 3 * s + 1e-9; x += s) for (let y = cy - 3 * s; y <= cy + 3 * s + 1e-9; y += s) { if (x < .1 || y < .1) continue; const e = err(x, y); if (e < be) { be = e; bx = x; by = y; } } }
  return { lh: bx, la: by };
}
// uygulamadaki ile aynı: zaman ağırlıklı, rakip gücüne göre düzeltilmiş hücum/savunma
function ratings(R, at) {
  if (R.length < 12) return null;
  const W = R.map(r => Math.pow(.5, Math.max(0, at - r.t) / DAY / HL));
  let sw = 0, sh = 0, sa = 0; R.forEach((r, i) => { sw += W[i]; sh += W[i] * r.hg; sa += W[i] * r.ag; });
  const mu = (sh + sa) / (2 * sw) || 1.3, hfa = Math.min(1.45, Math.max(1, Math.sqrt((sh || 1) / (sa || 1))));
  const att = {}, def = {}, n = {}; R.forEach(r => { [r.h, r.a].forEach(t => { att[t] = 1; def[t] = 1; n[t] = (n[t] || 0) + 1; }); });
  const ts = Object.keys(att);
  for (let it = 0; it < 12; it++) {
    const nA = {}, dA = {}, nD = {}, dD = {}; ts.forEach(t => { nA[t] = dA[t] = nD[t] = dD[t] = 0; });
    R.forEach((r, i) => { const w = W[i], h = r.h, a = r.a;
      nA[h] += w * r.hg; dA[h] += w * mu * def[a] * hfa; nA[a] += w * r.ag; dA[a] += w * mu * def[h] / hfa;
      nD[h] += w * r.ag; dD[h] += w * mu * att[a] / hfa; nD[a] += w * r.hg; dD[a] += w * mu * att[h] * hfa; });
    let ma = 0, md = 0; ts.forEach(t => { att[t] = (nA[t] + K * mu) / (dA[t] + K * mu); def[t] = (nD[t] + K * mu) / (dD[t] + K * mu); ma += att[t]; md += def[t]; });
    ma /= ts.length; md /= ts.length; ts.forEach(t => { att[t] /= ma; def[t] /= md; });
  }
  return { mu, hfa, att, def, n };
}
function parseCSV(txt) {
  const lines = txt.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',');
  return lines.slice(1).map(l => { const c = l.split(','); const o = {}; head.forEach((h, i) => o[h] = c[i]); return o; });
}
function parseDate(s) { const [d, m, y] = String(s || '').split('/').map(Number); if (!d || !m || !y) return NaN; return Date.UTC(y < 100 ? 2000 + y : y, m - 1, d, 12); }
const num = v => { const x = parseFloat(v); return Number.isFinite(x) && x > 1 ? x : null; };
async function getCSV(div, season) {
  if (SRC) { const f = `${SRC}/${season}_${div}.csv`; return fs.existsSync(f) ? fs.readFileSync(f, 'latin1') : null; }
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return new TextDecoder('latin1').decode(await r.arrayBuffer());
      if (r.status === 404) return null;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}
const hit = (k, hg, ag) => ({ '1': hg > ag, 'X': hg === ag, '2': hg < ag, 'O25': hg + ag > 2.5, 'U25': hg + ag < 2.5 })[k];

// ---------- ana akış ----------
const grid = {}; WS.forEach(w => EVS.forEach(e => grid[w + '|' + e] = { w, minEV: e, bets: 0, profit: 0, wins: 0, byLg: {} }));
const brier = { model: 0, market: 0, blend: 0, n: 0 };
const calib = Array.from({ length: 10 }, (_, i) => ({ bin: i, pred: 0, act: 0, n: 0 }));
const coverage = {};
let totalMatches = 0;

for (const [lg, div] of Object.entries(LEAGUES)) {
  const rows = [];
  for (const s of SEASONS) {
    const txt = await getCSV(div, s); if (!txt) continue;
    parseCSV(txt).forEach(r => {
      const t = parseDate(r.Date), hg = +r.FTHG, ag = +r.FTAG;
      if (!Number.isFinite(t) || !r.HomeTeam || !r.AwayTeam || r.FTHG === '' || r.FTHG == null || !Number.isFinite(hg) || !Number.isFinite(ag)) return;
      rows.push({ t, s, h: r.HomeTeam, a: r.AwayTeam, hg, ag,
        avg: { '1': num(r.AvgH ?? r.BbAvH), 'X': num(r.AvgD ?? r.BbAvD), '2': num(r.AvgA ?? r.BbAvA), 'O25': num(r['Avg>2.5'] ?? r['BbAv>2.5']), 'U25': num(r['Avg<2.5'] ?? r['BbAv<2.5']) },
        max: { '1': num(r.MaxH ?? r.BbMxH), 'X': num(r.MaxD ?? r.BbMxD), '2': num(r.MaxA ?? r.BbMxA), 'O25': num(r['Max>2.5'] ?? r['BbMx>2.5']), 'U25': num(r['Max<2.5'] ?? r['BbMx<2.5']) } });
    });
  }
  rows.sort((x, y) => x.t - y.t);
  let used = 0; const dates = [...new Set(rows.map(r => r.t))];
  let cacheT = null, cacheR = null;
  for (const r of rows) {
    if (r.s < BET_FROM) continue;
    if (cacheT !== r.t) { cacheT = r.t; cacheR = ratings(rows.filter(x => x.t < r.t && x.t > r.t - WINDOW), r.t); }
    const R = cacheR; if (!R || (R.n[r.h] || 0) < 3 || (R.n[r.a] || 0) < 3) continue;
    const o = r.avg; if (!o['1'] || !o['X'] || !o['2']) continue;
    const lhM = R.mu * R.att[r.h] * R.def[r.a] * R.hfa, laM = R.mu * R.att[r.a] * R.def[r.h] / R.hfa;
    const s3 = 1 / o['1'] + 1 / o['X'] + 1 / o['2'];
    const q = { h: 1 / o['1'] / s3, d: 1 / o['X'] / s3, a: 1 / o['2'] / s3 };
    if (o.O25 && o.U25) q.o25 = (1 / o.O25) / (1 / o.O25 + 1 / o.U25);
    const mk = impliedLambdas(q, RHO);
    const res = { h: r.hg > r.ag ? 1 : 0, d: r.hg === r.ag ? 1 : 0, a: r.hg < r.ag ? 1 : 0 };
    const pm = dcProbs(lhM, laM, RHO);
    brier.model += (pm.h - res.h) ** 2 + (pm.d - res.d) ** 2 + (pm.a - res.a) ** 2;
    brier.market += (q.h - res.h) ** 2 + (q.d - res.d) ** 2 + (q.a - res.a) ** 2;
    used++;
    for (const w of WS) {
      const lh = Math.exp((1 - w) * Math.log(lhM) + w * Math.log(mk.lh)), la = Math.exp((1 - w) * Math.log(laM) + w * Math.log(mk.la));
      const P = dcProbs(lh, la, RHO);
      const probs = { '1': P.h, 'X': P.d, '2': P.a, 'O25': P.o25, 'U25': 1 - P.o25 };
      if (w === 0.6) {
        brier.blend += (P.h - res.h) ** 2 + (P.d - res.d) ** 2 + (P.a - res.a) ** 2;
        for (const k of Object.keys(probs)) { if (k.startsWith('O') && !o.O25) continue; const b = Math.min(9, Math.floor(probs[k] * 10)); calib[b].pred += probs[k]; calib[b].act += hit(k, r.hg, r.ag) ? 1 : 0; calib[b].n++; }
      }
      for (const k of Object.keys(probs)) {
        const av = o[k]; if (!av) continue;
        const price = Math.min(r.max[k] || av, av * CAP);
        const ev = probs[k] * price - 1;
        for (const e of EVS) {
          if (ev < e || ev > 0.20) continue;
          const G = grid[w + '|' + e], won = hit(k, r.hg, r.ag);
          G.bets++; G.profit += won ? price - 1 : -1; if (won) G.wins++;
          const L = G.byLg[lg] = G.byLg[lg] || { bets: 0, profit: 0 }; L.bets++; L.profit += won ? price - 1 : -1;
        }
      }
    }
  }
  coverage[lg] = { name: NAMES[lg], matches: used };
  totalMatches += used;
  console.log(lg, 'satır:', rows.length, 'test edilen maç:', used);
}
brier.n = totalMatches;
const res = Object.values(grid).map(G => ({ w: G.w, minEV: G.minEV, bets: G.bets, roi: G.bets ? +(G.profit / G.bets * 100).toFixed(1) : 0, hit: G.bets ? +(G.wins / G.bets * 100).toFixed(1) : 0,
  byLg: Object.fromEntries(Object.entries(G.byLg).map(([k, v]) => [k, { bets: v.bets, roi: +(v.profit / v.bets * 100).toFixed(1) }])) }));
const pool = res.filter(r => r.bets >= 150);
const best = (pool.length ? pool : res).slice().sort((a, b) => b.roi - a.roi)[0] || null;
const out = {
  updated: new Date().toISOString(), seasons: SEASONS.slice(1), matches: totalMatches, coverage,
  brier: totalMatches ? { model: +(brier.model / totalMatches).toFixed(4), market: +(brier.market / totalMatches).toFixed(4), blend: +(brier.blend / totalMatches).toFixed(4) } : null,
  calib: calib.filter(c => c.n).map(c => ({ bin: c.bin, pred: +(c.pred / c.n * 100).toFixed(1), act: +(c.act / c.n * 100).toFixed(1), n: c.n })),
  grid: res, best,
  note: 'Bahis: tek maç, sabit 1 birim; oran = en yüksek oran (ortalamanın en fazla %4 üstü); değer %20 üstü seçimler hariç.'
};
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/backtest.json', JSON.stringify(out));
console.log('Toplam test edilen maç:', totalMatches, 'En iyi ayar:', JSON.stringify(best && { w: best.w, minEV: best.minEV, bets: best.bets, roi: best.roi }));
