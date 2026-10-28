// engine.js と学習済みの重み（weights.txt）を shogi.html の <script id="engine"> に書き込む
//   node shogi-ai/build.js
'use strict';
const fs = require('fs'), path = require('path');
const html = path.join(__dirname, '..', 'shogi.html');
const engine = fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8');
const weights = fs.readFileSync(path.join(__dirname, 'weights.txt'), 'utf8').trim();
const code = `${engine}
// ---- ここから Web Worker 用（build.js が追加）----
setWeights(decodeWeights('${weights}'));
onmessage = e => {
  setPosition(e.data.pos);
  const r = think(e.data.opts);
  postMessage({ gen: e.data.gen, move: r.move, score: r.score, depth: r.depth });
};
`;
const src = fs.readFileSync(html, 'utf8');
const re = /(<script id="engine" type="text\/plain">\n)[\s\S]*?(<\/script>)/;
if (!re.test(src)) throw new Error('shogi.html に <script id="engine" type="text/plain"> が見つからない');
fs.writeFileSync(html, src.replace(re, (_, a, b) => a + code + b));
console.log('shogi.html を更新しました');
