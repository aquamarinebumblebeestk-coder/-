// 将棋AIの評価
//   node shogi-ai/bench.js positions [局数]           … 自己対局からテスト局面を作り、長く読んだ手（正解）を付ける
//   node shogi-ai/bench.js levels [engine]            … 各レベルの正解一致率・悪手率・詰みの見逃し
//   node shogi-ai/bench.js match 新engine 旧engine [局数] [1手のms]
//                                                     … 2つのエンジンを同じ持ち時間で対局させる
// テスト局面は shogi-ai/bench-positions.json に保存する
'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path'), os = require('os');

const POS_FILE = path.join(__dirname, 'bench-positions.json');
const WEIGHTS = fs.readFileSync(path.join(__dirname, 'weights.txt'), 'utf8').trim();
const ORACLE_MS = 4000;   // 正解を作るときに1局面で読む時間
const CHECK_MS = 1000;    // 選んだ手の良し悪しを測るときに読む時間
// shogi.html の LEVELS と同じもの
const LEVELS = [
  ['入門', { maxDepth: 1, noise: 400 }],
  ['初級', { maxDepth: 2, noise: 150 }],
  ['中級', { maxDepth: 3, noise: 40 }],
  ['上級', { timeMs: 1500 }],
  ['有段', { timeMs: 5000 }],
];
const MATE = 30000;

function load(file) {
  const E = require(path.resolve(file));
  E.setWeights(E.decodeWeights(WEIGHTS));
  return E;
}

if (!isMainThread) parentPort.postMessage(work(workerData));
else main();

function work({ task, items, engine, engine2, ms, seed }) {
  const E = load(engine || path.join(__dirname, 'engine.js'));
  if (task === 'gen') {
    // 序盤は乱数を混ぜて指し、20手目から10手おきに局面を取る
    const out = [];
    for (let g = 0; g < items; g++) {
      E.setPosition(E.startPosition()); E.clearTT();
      for (let ply = 0; ply < 250; ply++) {
        const r = E.think(ply < 10 ? { maxDepth: 1, noise: 300 } : { nodes: 20000 });
        if (!r.move) break;
        if (ply >= 20 && ply % 10 === 0) out.push(E.getPosition());
        E.makeMove(r.move);
      }
    }
    return out;
  }
  if (task === 'oracle') return items.map(p => { E.setPosition(p); E.clearTT(); const r = E.think({ timeMs: ORACLE_MS }); return { ...p, best: r.move, score: r.score }; });
  if (task === 'levels') {
    return items.map(p => LEVELS.map(([, opts]) => {
      E.setPosition(p); E.clearTT();
      const m = E.think(opts).move;
      if (m === p.best) return { move: m, agree: 1, loss: 0 };
      // 選んだ手を指したあとの局面を読んで、正解との差（損失）を出す
      E.makeMove(m); E.clearTT();
      const v = -E.think({ timeMs: CHECK_MS }).score;
      return { move: m, agree: 0, loss: Math.max(0, p.score - v), v };
    }));
  }
  if (task === 'match') {
    const A = E, B = load(engine2);
    let a = 0, b = 0, d = 0;
    for (let g = 0; g < items; g++) {
      // 同じ序盤を先後入れ替えて2局
      A.setPosition(A.startPosition());
      const plies = 6 + Math.floor(Math.random() * 8);
      for (let i = 0; i < plies; i++) A.makeMove(A.think({ maxDepth: 1, noise: 300 }).move);
      const start = A.getPosition();
      for (const aSide of [0, 1]) {
        A.setPosition(start); B.setPosition(start); A.clearTT(); B.clearTT();
        const hist = [];
        let winner = -1;
        for (let ply = 0; ply < 300; ply++) {
          const P = A.side === aSide ? A : B;
          if (P.setHistory) P.setHistory(hist);
          const r = P.think({ timeMs: ms });
          if (!r.move) { winner = A.side ^ 1; break; }
          hist.push(A.hashKey ? A.hashKey() : 0);
          A.makeMove(r.move); B.makeMove(r.move);
          // 同一局面4回で千日手（引き分け）
          if (A.hashKey && hist.filter(h => h === A.hashKey()).length >= 3) break;
        }
        if (winner < 0) d++; else if (winner === aSide) a++; else b++;
      }
    }
    return { a, b, d };
  }
}

function run(task, list, extra = {}) {
  const nw = os.cpus().length;
  const chunks = Array.isArray(list) ? Array.from({ length: nw }, (_, i) => list.filter((_, j) => j % nw === i)) : Array(nw).fill(Math.ceil(list / nw));
  return Promise.all(chunks.map(items => new Promise((res, rej) => {
    const wk = new Worker(__filename, { workerData: { task, items, ...extra } });
    wk.on('message', res); wk.on('error', rej);
  })));
}

const elo = r => r <= 0 ? -999 : r >= 1 ? 999 : Math.round(-400 * Math.log10(1 / r - 1));

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'positions') {
    const ps = (await run('gen', +process.argv[3] || 40)).flat();
    console.log(`${ps.length} 局面。正解を作成中（1局面 ${ORACLE_MS / 1000} 秒）…`);
    const done = (await run('oracle', ps)).flat();
    fs.writeFileSync(POS_FILE, JSON.stringify(done));
    console.log(`${POS_FILE} に保存`);
  } else if (cmd === 'levels') {
    const ps = JSON.parse(fs.readFileSync(POS_FILE, 'utf8'));
    const nw = os.cpus().length;
    const parts = await run('levels', ps, process.argv[3] ? { engine: process.argv[3] } : {});
    // run は j % nw で分けたので元の順に戻す
    const res = [];
    parts.forEach((part, i) => part.forEach((r, k) => { res[k * nw + i] = r; }));
    const mates = ps.map((p, i) => i).filter(i => ps[i].score > MATE - 500);
    console.log(`テスト局面 ${ps.length}（うち自分に詰みがある局面 ${mates.length}）`);
    console.log('レベル | 正解一致 | 平均損失 | 悪手(損失300以上) | 大悪手(1000以上) | 詰み発見');
    LEVELS.forEach(([name], L) => {
      const rs = res.map(r => r[L]);
      const avg = rs.reduce((s, r) => s + Math.min(r.loss, 2000), 0) / rs.length;
      const pct = f => (rs.filter(f).length / rs.length * 100).toFixed(1) + '%';
      const mf = mates.filter(i => res[i][L].agree || res[i][L].v > MATE - 500).length;
      console.log(`${name} | ${pct(r => r.agree)} | ${avg.toFixed(0)} | ${pct(r => r.loss >= 300)} | ${pct(r => r.loss >= 1000)} | ${mf}/${mates.length}`);
    });
  } else if (cmd === 'match') {
    const [, , , e1, e2, n, ms] = process.argv;
    const r = (await run('match', +n || 100, { engine: e1, engine2: e2, ms: +ms || 100 }))
      .reduce((s, x) => ({ a: s.a + x.a, b: s.b + x.b, d: s.d + x.d }), { a: 0, b: 0, d: 0 });
    const rate = (r.a + r.d / 2) / (r.a + r.b + r.d);
    console.log(`${e1} vs ${e2}: ${r.a}勝 ${r.b}敗 ${r.d}分（勝率 ${(rate * 100).toFixed(1)}%、Elo差 ${elo(rate)}）`);
  }
}
