// 評価関数の学習（自己対局による強化学習）
//   node shogi-ai/train.js [ラウンド数] [1ラウンドの対局数]
// 1. 今の重みで自己対局して局面・探索の評価値・勝敗を集める
// 2. 「探索の評価値」と「実際の勝敗」を混ぜた目標に評価関数が近づくようロジスティック回帰（Adam）で学習
// 3. 新しい重みと前の重みを対局させて強くなったか測る
// 結果は shogi-ai/weights.txt に保存。build.js で shogi.html に埋め込む
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path'), os = require('os');
const E = require('./engine.js');

const WEIGHTS = path.join(__dirname, 'weights.txt');
const K = 600;            // 評価値→勝率の換算（評価値 600 で勝率 73%）
const LAMBDA = 0.5;       // 目標のうち探索の評価値の割合（残りは勝敗）
const PLAY_NODES = 8000;  // 自己対局で1手に読む局面数
const MAX_PLY = 300;

if (!isMainThread) {
  const { task, n, w, w2, nodes } = workerData;
  if (task === 'selfplay') parentPort.postMessage(selfplay(n, E.decodeWeights(w), nodes));
  else parentPort.postMessage(match(n, E.decodeWeights(w), E.decodeWeights(w2), nodes));
} else main();

// 序盤は乱数を混ぜて毎局違う将棋にする
function opening(plies) {
  E.setPosition(E.startPosition());
  E.setWeights(E.materialWeights());
  for (let i = 0; i < plies; i++) {
    const r = E.think({ maxDepth: 1, noise: 300 });
    if (!r.move) return false;
    E.makeMove(r.move);
  }
  return E.hasLegalMove();
}

function selfplay(n, w, nodes) {
  const recs = [];
  for (let g = 0; g < n; g++) {
    opening(6 + Math.floor(Math.random() * 10));
    E.setWeights(w); E.clearTT();
    const game = [];
    let result = 0.5;
    for (let ply = 0; ply < MAX_PLY; ply++) {
      const r = E.think({ nodes });
      if (!r.move) { result = E.side ? 1 : 0; break; }
      if (!E.inCheck() && !E.isCapture(r.move) && Math.abs(r.score) < 3000) {
        const f = E.features();
        game.push({ idx: Int32Array.from(f.idx), sgn: Int8Array.from(f.sgn), score: E.side ? -r.score : r.score });
      }
      E.makeMove(r.move);
    }
    for (const p of game) p.result = result;
    recs.push(...game);
  }
  return recs;
}

function match(n, wa, wb, nodes) {
  let a = 0, b = 0, d = 0;
  for (let g = 0; g < n; g++) {
    opening(4 + Math.floor(Math.random() * 8));
    const start = E.getPosition();
    // 同じ序盤を先後入れ替えて2局
    for (const aSide of [0, 1]) {
      E.setPosition(start); E.clearTT();
      let winner = -1;
      for (let ply = 0; ply < MAX_PLY; ply++) {
        E.setWeights(E.side === aSide ? wa : wb);
        const r = E.think({ nodes });
        if (!r.move) { winner = E.side ^ 1; break; }
        E.makeMove(r.move);
      }
      if (winner < 0) d++; else if (winner === aSide) a++; else b++;
    }
  }
  return { a, b, d };
}

function runWorkers(task, total, extra) {
  const nw = os.cpus().length, per = Math.ceil(total / nw);
  return Promise.all(Array.from({ length: nw }, () => new Promise((res, rej) => {
    const wk = new Worker(__filename, { workerData: { task, n: per, ...extra } });
    wk.on('message', res); wk.on('error', rej);
  })));
}

const sigmoid = x => 1 / (1 + Math.exp(-x));

function train(w, data, epochs) {
  const m = new Float64Array(E.NW), v = new Float64Array(E.NW), g = new Float64Array(E.NW);
  const touched = new Uint8Array(E.NW);
  const valid = data.filter((_, i) => i % 20 === 0), tr = data.filter((_, i) => i % 20 !== 0);
  const loss = set => {
    let L = 0;
    for (const p of set) {
      let e = 0;
      for (let i = 0; i < p.idx.length; i++) e += p.sgn[i] * w[p.idx[i]];
      const t = LAMBDA * sigmoid(p.score / K) + (1 - LAMBDA) * p.result, q = Math.min(Math.max(sigmoid(e / K), 1e-6), 1 - 1e-6);
      L -= t * Math.log(q) + (1 - t) * Math.log(1 - q);
    }
    return L / set.length;
  };
  console.log(`  学習データ ${tr.length} 局面、検証 ${valid.length} 局面。学習前の検証損失 ${loss(valid).toFixed(4)}`);
  const B = 512, b1 = 0.9, b2 = 0.999;
  let step = 0;
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = tr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tr[i], tr[j]] = [tr[j], tr[i]]; }
    const lr = 2 * (1 - ep / epochs) + 0.2;
    for (let s = 0; s < tr.length; s += B) {
      g.fill(0); touched.fill(0);
      const end = Math.min(s + B, tr.length);
      for (let k = s; k < end; k++) {
        const p = tr[k];
        let e = 0;
        for (let i = 0; i < p.idx.length; i++) e += p.sgn[i] * w[p.idx[i]];
        const t = LAMBDA * sigmoid(p.score / K) + (1 - LAMBDA) * p.result;
        const d = (sigmoid(e / K) - t) / K;
        for (let i = 0; i < p.idx.length; i++) { g[p.idx[i]] += p.sgn[i] * d; touched[p.idx[i]] = 1; }
      }
      step++;
      for (let i = 0; i < E.NW; i++) {
        if (!touched[i]) continue;
        const gi = g[i] / (end - s) * 1e4;
        m[i] = b1 * m[i] + (1 - b1) * gi; v[i] = b2 * v[i] + (1 - b2) * gi * gi;
        w[i] -= lr * (m[i] / (1 - b1 ** step)) / (Math.sqrt(v[i] / (1 - b2 ** step)) + 1e-8);
      }
    }
    console.log(`  エポック ${ep + 1}: 検証損失 ${loss(valid).toFixed(4)}`);
  }
}

const elo = r => r <= 0 ? -999 : r >= 1 ? 999 : Math.round(-400 * Math.log10(1 / r - 1));

async function main() {
  const rounds = +process.argv[2] || 3, games = +process.argv[3] || 800;
  const start = E.materialWeights();
  let w = fs.existsSync(WEIGHTS) ? E.decodeWeights(fs.readFileSync(WEIGHTS, 'utf8').trim()) : start;
  let pool = [];
  for (let r = 1; r <= rounds; r++) {
    let t = Date.now();
    console.log(`ラウンド ${r}: 自己対局 ${games} 局`);
    const parts = await runWorkers('selfplay', games, { w: E.encodeWeights(w), nodes: PLAY_NODES });
    const data = parts.flat();
    console.log(`  ${data.length} 局面を収集（${((Date.now() - t) / 1000) | 0} 秒）`);
    pool = pool.slice(-400000).concat(data);   // 直近のデータを残して使う
    const prev = Float32Array.from(w);
    t = Date.now();
    train(w, pool, 4);
    console.log(`  学習 ${((Date.now() - t) / 1000) | 0} 秒`);
    const res = (await runWorkers('match', 100, { w: E.encodeWeights(w), w2: E.encodeWeights(prev), nodes: PLAY_NODES }))
      .reduce((s, x) => ({ a: s.a + x.a, b: s.b + x.b, d: s.d + x.d }), { a: 0, b: 0, d: 0 });
    const rate = (res.a + res.d / 2) / (res.a + res.b + res.d);
    console.log(`  新 vs 前: ${res.a}勝 ${res.b}敗 ${res.d}分（勝率 ${(rate * 100).toFixed(1)}%、Elo差 ${elo(rate)}）`);
    fs.writeFileSync(WEIGHTS, E.encodeWeights(w));
  }
  const res = (await runWorkers('match', 100, { w: E.encodeWeights(w), w2: E.encodeWeights(start), nodes: PLAY_NODES }))
    .reduce((s, x) => ({ a: s.a + x.a, b: s.b + x.b, d: s.d + x.d }), { a: 0, b: 0, d: 0 });
  const rate = (res.a + res.d / 2) / (res.a + res.b + res.d);
  console.log(`最終 vs 駒の価値だけの評価: ${res.a}勝 ${res.b}敗 ${res.d}分（勝率 ${(rate * 100).toFixed(1)}%、Elo差 ${elo(rate)}）`);
}
