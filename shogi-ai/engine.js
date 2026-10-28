// 将棋の思考エンジン（ブラウザの Web Worker と Node の学習スクリプトで共用）
// 駒種: 1歩 2香 3桂 4銀 5金 6角 7飛 8玉、+8 で成駒（9と 10成香 11成桂 12成銀 14馬 15龍）
// 盤: 81マス、sq = 段*9 + 列（0 が 9一 = 左上）。先手の駒は正、後手の駒は負の値
// 指し手: from | to << 7 | 成り << 14。持ち駒を打つ手は from = 80 + 駒種
'use strict';

const NW_PST = 16 * 81, NW_KREL = 16 * 289, NW_HAND = 8 * 19;
const O_PST = 0, O_KOWN = O_PST + NW_PST, O_KOPP = O_KOWN + NW_KREL, O_HAND = O_KOPP + NW_KREL;
const NW = O_HAND + NW_HAND;
const MATE = 30000, INF = 32000;

// 8方向（先手から見た向き）。0:左上 1:上 2:右上 3:左 4:右 5:左下 6:下 7:右下。逆向きは 7-d
const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
const GOLD = [0, 1, 2, 3, 4, 6], ORTH = [1, 3, 4, 6], DIAG = [0, 2, 5, 7];
const STEP_D = { 1: [1], 4: [0, 1, 2, 5, 7], 5: GOLD, 8: [0, 1, 2, 3, 4, 5, 6, 7], 9: GOLD, 10: GOLD, 11: GOLD, 12: GOLD, 14: ORTH, 15: DIAG };
const SLIDE_D = { 2: [1], 6: DIAG, 7: ORTH, 14: DIAG, 15: ORTH };
const flipDir = d => [5, 6, 7, 3, 4, 0, 1, 2][d];

const STEPM = [new Int32Array(16), new Int32Array(16)], SLIDEM = [new Int32Array(16), new Int32Array(16)];
for (let s = 0; s < 2; s++) for (let t = 1; t < 16; t++) {
  for (const d of STEP_D[t] || []) STEPM[s][t] |= 1 << (s ? flipDir(d) : d);
  for (const d of SLIDE_D[t] || []) SLIDEM[s][t] |= 1 << (s ? flipDir(d) : d);
}
const NB = new Int32Array(81 * 8).fill(-1);
const KNT = [[], []], KNSRC = [[], []];
for (let sq = 0; sq < 81; sq++) {
  const r = Math.floor(sq / 9), c = sq % 9;
  DIRS.forEach(([dr, dc], d) => {
    const y = r + dr, x = c + dc;
    if (y >= 0 && y < 9 && x >= 0 && x < 9) NB[sq * 8 + d] = y * 9 + x;
  });
  for (let s = 0; s < 2; s++) {
    KNT[s][sq] = []; KNSRC[s][sq] = [];
    const f = s ? 2 : -2;
    for (const dc of [-1, 1]) {
      if (r + f >= 0 && r + f < 9 && c + dc >= 0 && c + dc < 9) KNT[s][sq].push((r + f) * 9 + c + dc);
      if (r - f >= 0 && r - f < 9 && c + dc >= 0 && c + dc < 9) KNSRC[s][sq].push((r - f) * 9 + c + dc);
    }
  }
}
// 駒と玉の相対位置（先手視点）→ 0..288
const REL = new Int32Array(81 * 81);
for (let a = 0; a < 81; a++) for (let k = 0; k < 81; k++)
  REL[a * 81 + k] = (Math.floor(a / 9) - Math.floor(k / 9) + 8) * 17 + (a % 9 - k % 9 + 8);

// 盤面の状態
const board = new Int8Array(81), hand = new Int8Array(16), king = new Int32Array(2);
let side = 0, hashLo = 0, hashHi = 0;

// ハッシュ用の乱数
let seed = 12345;
const rnd32 = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed | 0; };
const ZLO = new Int32Array(32 * 81), ZHI = new Int32Array(32 * 81), ZHLO = new Int32Array(16 * 20), ZHHI = new Int32Array(16 * 20);
for (let i = 0; i < ZLO.length; i++) { ZLO[i] = rnd32(); ZHI[i] = rnd32(); }
for (let i = 0; i < ZHLO.length; i++) { ZHLO[i] = rnd32(); ZHHI[i] = rnd32(); }
const ZSIDE_LO = rnd32(), ZSIDE_HI = rnd32();
const zp = (p, sq) => (p + 16) * 81 + sq;

function computeHash() {
  hashLo = 0; hashHi = 0;
  for (let sq = 0; sq < 81; sq++) if (board[sq]) { hashLo ^= ZLO[zp(board[sq], sq)]; hashHi ^= ZHI[zp(board[sq], sq)]; }
  for (let i = 0; i < 16; i++) { hashLo ^= ZHLO[i * 20 + hand[i]]; hashHi ^= ZHHI[i * 20 + hand[i]]; }
  if (side) { hashLo ^= ZSIDE_LO; hashHi ^= ZSIDE_HI; }
}

// pos = { board: 81要素, hand: [先手{1..7: 枚数}, 後手{...}], side }
function setPosition(pos) {
  for (let i = 0; i < 81; i++) { board[i] = pos.board[i]; if (board[i] === 8) king[0] = i; if (board[i] === -8) king[1] = i; }
  for (let s = 0; s < 2; s++) for (let t = 0; t < 8; t++) hand[s * 8 + t] = pos.hand[s][t] || 0;
  side = pos.side;
  computeHash();
}
function getPosition() {
  return { board: Array.from(board), hand: [0, 1].map(s => Array.from(hand.slice(s * 8, s * 8 + 8))), side };
}
function startPosition() {
  const b = Array(81).fill(0), back = [2, 3, 4, 5, 8, 5, 4, 3, 2];
  back.forEach((t, c) => { b[c] = -t; b[72 + c] = t; });
  for (let c = 0; c < 9; c++) { b[18 + c] = -1; b[54 + c] = 1; }
  b[10] = -7; b[16] = -6; b[64] = 6; b[70] = 7;
  return { board: b, hand: [[0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]], side: 0 };
}

// by 側の駒が sq に利いているか
function isAttacked(sq, by) {
  const sign = by ? -1 : 1, sm = STEPM[by], lm = SLIDEM[by];
  for (let d = 0; d < 8; d++) {
    let x = NB[sq * 8 + 7 - d];
    if (x < 0) continue;
    let p = board[x];
    if (p) {
      if (p * sign > 0) { const t = p * sign; if ((sm[t] | lm[t]) >> d & 1) return true; }
      continue;
    }
    for (x = NB[x * 8 + 7 - d]; x >= 0; x = NB[x * 8 + 7 - d]) {
      p = board[x];
      if (!p) continue;
      if (p * sign > 0 && lm[p * sign] >> d & 1) return true;
      break;
    }
  }
  for (const x of KNSRC[by][sq]) if (board[x] === sign * 3) return true;
  return false;
}
const inCheck = s => isAttacked(king[s], s ^ 1);

const inZone = (s, sq) => s ? sq >= 54 : sq < 27;
const farRank = (s, sq) => s ? 8 - Math.floor(sq / 9) : Math.floor(sq / 9);

function pushBoardMove(out, s, from, to, t, capOnly) {
  if (capOnly && !board[to]) return;
  const base = from | to << 7;
  if (t <= 7 && t !== 5 && (inZone(s, from) || inZone(s, to))) {
    out.push(base | 1 << 14);
    const rr = farRank(s, to);
    // 歩・角・飛は成らない理由がほぼ無いので不成は読まない
    if (t === 2 && rr > 0 || t === 3 && rr > 1 || t === 4) out.push(base);
  } else out.push(base);
}

function genMoves(capOnly) {
  const s = side, sign = s ? -1 : 1, out = [];
  for (let sq = 0; sq < 81; sq++) {
    const p = board[sq] * sign;
    if (p <= 0) continue;
    let m = STEPM[s][p];
    for (let d = 0; m; d++, m >>= 1) {
      if (!(m & 1)) continue;
      const to = NB[sq * 8 + d];
      if (to >= 0 && board[to] * sign <= 0) pushBoardMove(out, s, sq, to, p, capOnly);
    }
    m = SLIDEM[s][p];
    for (let d = 0; m; d++, m >>= 1) {
      if (!(m & 1)) continue;
      for (let to = NB[sq * 8 + d]; to >= 0; to = NB[to * 8 + d]) {
        const q = board[to] * sign;
        if (q > 0) break;
        pushBoardMove(out, s, sq, to, p, capOnly);
        if (q < 0) break;
      }
    }
    if (p === 3) for (const to of KNT[s][sq]) if (board[to] * sign <= 0) {
      if (capOnly && !board[to]) continue;
      const rr = farRank(s, to), base = sq | to << 7;
      if (inZone(s, to)) out.push(base | 1 << 14);
      if (rr > 1) out.push(base);
    }
  }
  if (capOnly) return out;
  let pawnFiles = 0;
  for (let sq = 0; sq < 81; sq++) if (board[sq] === sign) pawnFiles |= 1 << sq % 9;
  for (let t = 7; t >= 1; t--) {
    if (!hand[s * 8 + t]) continue;
    for (let to = 0; to < 81; to++) {
      if (board[to]) continue;
      const rr = farRank(s, to);
      if (t <= 2 && rr === 0 || t === 3 && rr <= 1) continue;
      if (t === 1 && pawnFiles >> to % 9 & 1) continue;
      out.push(80 + t | to << 7);
    }
  }
  return out;
}

const undoCap = new Int8Array(1024), undoLo = new Int32Array(1024), undoHi = new Int32Array(1024);
let sp = 0;
function xorHand(i) { hashLo ^= ZHLO[i * 20 + hand[i]]; hashHi ^= ZHHI[i * 20 + hand[i]]; }
function xorPiece(p, sq) { hashLo ^= ZLO[zp(p, sq)]; hashHi ^= ZHI[zp(p, sq)]; }

function makeMove(m) {
  const from = m & 127, to = m >> 7 & 127, s = side, sign = s ? -1 : 1;
  undoLo[sp] = hashLo; undoHi[sp] = hashHi;
  if (from > 80) {
    const t = from - 80, p = sign * t;
    xorHand(s * 8 + t); hand[s * 8 + t]--; xorHand(s * 8 + t);
    board[to] = p; xorPiece(p, to);
    undoCap[sp++] = 0;
  } else {
    const p = board[from], cap = board[to];
    if (cap) {
      let ct = cap < 0 ? -cap : cap;
      if (ct > 8) ct -= 8;
      xorPiece(cap, to);
      xorHand(s * 8 + ct); hand[s * 8 + ct]++; xorHand(s * 8 + ct);
    }
    const np = m >> 14 ? p + sign * 8 : p;
    xorPiece(p, from); board[from] = 0;
    board[to] = np; xorPiece(np, to);
    if (np === sign * 8) king[s] = to;
    undoCap[sp++] = cap;
  }
  side ^= 1; hashLo ^= ZSIDE_LO; hashHi ^= ZSIDE_HI;
}

function unmakeMove(m) {
  const from = m & 127, to = m >> 7 & 127;
  side ^= 1;
  const s = side, sign = s ? -1 : 1, cap = undoCap[--sp];
  hashLo = undoLo[sp]; hashHi = undoHi[sp];
  if (from > 80) {
    hand[s * 8 + from - 80]++;
    board[to] = 0;
  } else {
    const np = board[to], p = m >> 14 ? np - sign * 8 : np;
    board[from] = p; board[to] = cap;
    if (p === sign * 8) king[s] = from;
    if (cap) { let ct = cap < 0 ? -cap : cap; if (ct > 8) ct -= 8; hand[s * 8 + ct]--; }
  }
}

function hasLegalMove() {
  const s = side;
  for (const m of genMoves(false)) {
    makeMove(m);
    const ok = !inCheck(s);
    unmakeMove(m);
    if (ok) return true;
  }
  return false;
}

// 指した直後に呼ぶ：指した側の玉が取られない＆打ち歩詰めでないか
function lastMoveLegal(m) {
  const s = side ^ 1;
  if (inCheck(s)) return false;
  const from = m & 127, to = m >> 7 & 127;
  if (from === 81 && king[side] === to + (s ? 9 : -9) && !hasLegalMove()) return false;
  return true;
}

function legalMoves() {
  const out = [];
  for (const m of genMoves(false)) { makeMove(m); if (lastMoveLegal(m)) out.push(m); unmakeMove(m); }
  return out;
}

// ---- 評価関数（学習で求めた重みの線形和）----
let W = new Float32Array(NW);
function setWeights(w) { W = w; }

function pieceValue(s, t, sq) {
  const rs = s ? 80 - sq : sq;
  if (t === 8) return W[O_PST + 8 * 81 + rs];
  const ok = s ? 80 - king[s] : king[s], ek = s ? 80 - king[s ^ 1] : king[s ^ 1];
  return W[O_PST + t * 81 + rs] + W[O_KOWN + t * 289 + REL[rs * 81 + ok]] + W[O_KOPP + t * 289 + REL[rs * 81 + ek]];
}

function evaluate() {
  let v = 0;
  for (let sq = 0; sq < 81; sq++) {
    const p = board[sq];
    if (p > 0) v += pieceValue(0, p, sq); else if (p < 0) v -= pieceValue(1, -p, sq);
  }
  for (let t = 1; t < 8; t++) v += W[O_HAND + t * 19 + hand[t]] - W[O_HAND + t * 19 + hand[8 + t]];
  return side ? -v : v;
}

// 学習用：先手から見た評価値の特徴（重みの添字と符号）
function features() {
  const idx = [], sgn = [];
  const add = (i, g) => { idx.push(i); sgn.push(g); };
  for (let sq = 0; sq < 81; sq++) {
    const p = board[sq];
    if (!p) continue;
    const s = p > 0 ? 0 : 1, t = p > 0 ? p : -p, g = s ? -1 : 1, rs = s ? 80 - sq : sq;
    add(O_PST + t * 81 + rs, g);
    if (t === 8) continue;
    const ok = s ? 80 - king[s] : king[s], ek = s ? 80 - king[s ^ 1] : king[s ^ 1];
    add(O_KOWN + t * 289 + REL[rs * 81 + ok], g);
    add(O_KOPP + t * 289 + REL[rs * 81 + ek], g);
  }
  for (let t = 1; t < 8; t++) { add(O_HAND + t * 19 + hand[t], 1); add(O_HAND + t * 19 + hand[8 + t], -1); }
  return { idx, sgn };
}

// 駒の価値だけの初期重み（学習の出発点）
function materialWeights() {
  const w = new Float32Array(NW);
  const val = [0, 90, 300, 350, 500, 550, 750, 900, 0, 550, 550, 550, 550, 0, 1000, 1150];
  for (let t = 1; t < 16; t++) for (let sq = 0; sq < 81; sq++) w[O_PST + t * 81 + sq] = val[t];
  for (let t = 1; t < 8; t++) for (let c = 0; c < 19; c++) w[O_HAND + t * 19 + c] = c * val[t] * 1.1;
  return w;
}

function encodeWeights(w) {
  const a = new Int16Array(NW);
  for (let i = 0; i < NW; i++) a[i] = Math.max(-32768, Math.min(32767, Math.round(w[i])));
  const bytes = new Uint8Array(a.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function decodeWeights(b64) {
  const s = atob(b64), bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return Float32Array.from(new Int16Array(bytes.buffer));
}

// ---- 探索（反復深化アルファベータ＋静止探索＋置換表）----
const TT_BITS = 19, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
const ttKey = new Int32Array(TT_SIZE), ttMove = new Int32Array(TT_SIZE), ttScore = new Int32Array(TT_SIZE);
const ttDepth = new Int8Array(TT_SIZE), ttFlag = new Int8Array(TT_SIZE);
const killers = new Int32Array(128 * 2), histTable = new Int32Array(2 * 128 * 81);
let nodes = 0, deadline = Infinity, nodeLimit = Infinity, aborted = false;

function clearTT() { ttFlag.fill(0); killers.fill(0); histTable.fill(0); }

const ORDER_VAL = [0, 1, 3, 4, 5, 6, 8, 10, 50, 6, 6, 6, 6, 0, 11, 13];
function captureScore(m) {
  const cap = board[m >> 7 & 127], from = m & 127;
  const victim = ORDER_VAL[cap < 0 ? -cap : cap];
  const att = from > 80 ? 0 : ORDER_VAL[Math.abs(board[from])];
  return victim * 16 - att + (m >> 14 ? 8 : 0);
}

function orderMoves(moves, ttm, ply) {
  const sc = new Int32Array(moves.length), s = side;
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i];
    if (m === ttm) sc[i] = 1 << 30;
    else if (board[m >> 7 & 127]) sc[i] = (1 << 28) + captureScore(m);
    else if (m === killers[ply * 2]) sc[i] = 1 << 27;
    else if (m === killers[ply * 2 + 1]) sc[i] = (1 << 27) - 1;
    else sc[i] = histTable[(s * 128 + (m & 127)) * 81 + (m >> 7 & 127)] + (m >> 14 ? 500 : 0);
  }
  const ix = Array.from(moves.keys()).sort((a, b) => sc[b] - sc[a]);
  return ix.map(i => moves[i]);
}

function checkTime() {
  if ((++nodes & 2047) === 0 && (Date.now() > deadline)) aborted = true;
  if (nodes > nodeLimit) aborted = true;
}

function qsearch(alpha, beta, ply, qd) {
  checkTime();
  const stand = evaluate();
  if (stand >= beta || qd >= 6) return stand;
  if (stand > alpha) alpha = stand;
  const moves = genMoves(true);
  moves.sort((a, b) => captureScore(b) - captureScore(a));
  for (const m of moves) {
    makeMove(m);
    if (inCheck(side ^ 1)) { unmakeMove(m); continue; }
    const v = -qsearch(-beta, -alpha, ply + 1, qd + 1);
    unmakeMove(m);
    if (v >= beta) return v;
    if (v > alpha) alpha = v;
  }
  return alpha;
}

function search(depth, alpha, beta, ply) {
  if (depth <= 0) return qsearch(alpha, beta, ply, 0);
  checkTime();
  if (aborted) return 0;
  const ti = hashLo & TT_MASK;
  let ttm = 0;
  if (ttFlag[ti] && ttKey[ti] === hashHi) {
    ttm = ttMove[ti];
    if (ply > 0 && ttDepth[ti] >= depth) {
      let v = ttScore[ti];
      if (v > MATE - 500) v -= ply; else if (v < -MATE + 500) v += ply;
      const f = ttFlag[ti];
      if (f === 1 || (f === 2 && v >= beta) || (f === 3 && v <= alpha)) return v;
    }
  }
  const checked = inCheck(side);
  const moves = orderMoves(genMoves(false), ttm, ply);
  const a0 = alpha;
  let best = -INF, bestM = 0, legal = 0;
  for (const m of moves) {
    makeMove(m);
    if (!lastMoveLegal(m)) { unmakeMove(m); continue; }
    legal++;
    const quiet = !undoCap[sp - 1] && !(m >> 14);
    const givesCheck = inCheck(side);
    const ext = givesCheck && depth <= 2 && ply < 12 ? 1 : 0;
    let v;
    if (legal === 1) v = -search(depth - 1 + ext, -beta, -alpha, ply + 1);
    else {
      // 後ろの方の静かな手は浅く読む（LMR）
      const red = depth >= 3 && legal > 4 && quiet && !checked && !givesCheck ? (legal > 12 ? 2 : 1) : 0;
      v = -search(depth - 1 - red + ext, -alpha - 1, -alpha, ply + 1);
      if (v > alpha && (red || v < beta)) v = -search(depth - 1 + ext, -beta, -alpha, ply + 1);
    }
    unmakeMove(m);
    if (aborted) return 0;
    if (v > best) { best = v; bestM = m; }
    if (v > alpha) alpha = v;
    if (alpha >= beta) {
      if (quiet) {
        if (killers[ply * 2] !== m) { killers[ply * 2 + 1] = killers[ply * 2]; killers[ply * 2] = m; }
        histTable[(side * 128 + (m & 127)) * 81 + (m >> 7 & 127)] += depth * depth;
      }
      break;
    }
  }
  if (!legal) return -MATE + ply;
  let sv = best;
  if (sv > MATE - 500) sv += ply; else if (sv < -MATE + 500) sv -= ply;
  ttKey[ti] = hashHi; ttMove[ti] = bestM; ttScore[ti] = sv; ttDepth[ti] = depth;
  ttFlag[ti] = best >= beta ? 2 : best <= a0 ? 3 : 1;
  return best;
}

// 一番良い手を返す。opts: { maxDepth, timeMs, nodes, noise（ルートの手の点数に足す乱数の幅） }
function think(opts) {
  const maxDepth = opts.maxDepth || 64;
  deadline = Date.now() + (opts.timeMs || 1e9);
  nodeLimit = opts.nodes || Infinity;
  nodes = 0; aborted = false;
  const root = legalMoves();
  if (!root.length) return { move: 0, score: -MATE, depth: 0 };
  if (root.length === 1) return { move: root[0], score: 0, depth: 0 };
  // 弱いレベル：全部の手を同じ深さで点数付けして、乱数を足して選ぶ
  if (opts.noise) {
    let best = root[0], bestV = -INF, bestRaw = 0;
    for (const m of root) {
      makeMove(m);
      const v = -search(maxDepth - 1, -INF, INF, 1);
      unmakeMove(m);
      const nv = v + (Math.random() - 0.5) * 2 * opts.noise;
      if (nv > bestV) { bestV = nv; best = m; bestRaw = v; }
    }
    return { move: best, score: bestRaw, depth: maxDepth };
  }
  let bestM = root[0], bestV = 0, done = 0;
  let order = root;
  for (let d = 1; d <= maxDepth; d++) {
    let alpha = -INF, curBest = 0, curV = -INF;
    for (const m of order) {
      makeMove(m);
      let v;
      if (curBest === 0) v = -search(d - 1, -INF, -alpha, 1);
      else {
        v = -search(d - 1, -alpha - 1, -alpha, 1);
        if (v > alpha && !aborted) v = -search(d - 1, -INF, -alpha, 1);
      }
      unmakeMove(m);
      if (aborted) break;
      if (v > curV) { curV = v; curBest = m; }
      if (v > alpha) alpha = v;
    }
    if (aborted) { if (curBest && curV > bestV) bestM = curBest; break; }
    bestM = curBest; bestV = curV; done = d;
    order = [bestM, ...order.filter(m => m !== bestM)];
    if (bestV > MATE - 500 || bestV < -MATE + 500) break;
  }
  return { move: bestM, score: bestV, depth: done };
}

const Engine = {
  NW, MATE, setPosition, getPosition, startPosition, legalMoves, makeMove, unmakeMove, inCheck: () => inCheck(side),
  hasLegalMove, evaluate, features, think, clearTT, setWeights, materialWeights, encodeWeights, decodeWeights,
  get side() { return side; }, get nodes() { return nodes; }, isCapture: m => board[m >> 7 & 127] !== 0,
};
if (typeof module !== 'undefined') module.exports = Engine;
