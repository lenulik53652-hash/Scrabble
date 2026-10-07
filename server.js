// Slovak Scrabble for 4 players - dependency-free Node HTTP server.
// Game state is kept in memory and persisted to data/state.json after every action.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const STATE_FILE = path.join(__dirname, 'data', 'state.json');
const SIZE = 15, RACK = 7, BINGO = 50, PLAYERS = 4;

// letter -> [count, points]; 110 letters + 2 jokers ('?', 0 points); source: hramescrabble.sk ("slovenský m" + Q, W)
const TILES = {
  A: [9, 1], E: [8, 1], I: [6, 1], N: [5, 1], O: [10, 1], S: [5, 1], T: [4, 1], V: [5, 1],
  B: [2, 2], 'Á': [2, 2], D: [3, 2], J: [2, 2], K: [4, 2], L: [4, 2], M: [3, 2], P: [3, 2], R: [5, 2], U: [3, 2], Y: [2, 2], Z: [2, 2],
  C: [1, 3], 'Č': [1, 3], 'É': [1, 3], H: [1, 3], 'Í': [1, 3], 'Š': [1, 3], 'Ú': [1, 3], 'Ý': [1, 3], 'Ž': [1, 3],
  'Ť': [1, 4], 'Ľ': [1, 5], F: [1, 6], G: [1, 6], 'Ň': [1, 7], 'Ô': [1, 7],
  'Ä': [1, 8], 'Ď': [1, 8], 'Ó': [1, 8], 'Ĺ': [1, 9], 'Ŕ': [1, 9], X: [1, 9], Q: [1, 10], W: [1, 10],
};
const POINTS = Object.fromEntries(Object.entries(TILES).map(([k, v]) => [k, v[1]]));
POINTS['?'] = 0;

// --- premium squares (standard 15x15 layout) ---
const PREMIUM = Array.from({ length: SIZE }, () => Array(SIZE).fill(''));
const mark = (type, cells) => {
  for (const [r, c] of cells) for (const [a, b] of [[r, c], [c, r], [r, SIZE - 1 - c], [c, SIZE - 1 - r],
    [SIZE - 1 - r, c], [SIZE - 1 - c, r], [SIZE - 1 - r, SIZE - 1 - c], [SIZE - 1 - c, SIZE - 1 - r]]) PREMIUM[a][b] = type;
};
mark('TW', [[0, 0], [0, 7]]);
mark('DW', [[1, 1], [2, 2], [3, 3], [4, 4], [7, 7]]);
mark('TL', [[1, 5], [5, 5]]);
mark('DL', [[0, 3], [2, 6], [3, 7], [6, 6], [6, 2]]);

// --- dictionary ---
const WORDS = new Set(fs.readFileSync(path.join(__dirname, 'data', 'words.txt'), 'utf8').split('\n').filter(Boolean));
console.log(`Dictionary: ${WORDS.size} words`);

// --- game state ---
let game = null;

function newBag() {
  const bag = [];
  for (const [l, [n]] of Object.entries(TILES)) for (let i = 0; i < n; i++) bag.push(l);
  bag.push('?', '?');
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

function refill(p) {
  while (p.rack.length < RACK && game.bag.length) p.rack.push(game.bag.pop());
}

function newGame(names) {
  game = {
    id: Date.now(),
    board: Array.from({ length: SIZE }, () => Array(SIZE).fill(null)), // {l: letter, j: isJoker}
    bag: newBag(),
    players: Array.from({ length: PLAYERS }, (_, i) => ({
      name: (names && names[i] && String(names[i]).slice(0, 20)) || `Hráč ${i + 1}`, rack: [], score: 0,
    })),
    turn: 0, firstMove: true, passes: 0, over: false, winner: null, log: [],
  };
  game.players.forEach(refill);
  game.turn = Math.floor(Math.random() * PLAYERS);
  save();
}

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(game));
}

function load() {
  try { game = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { newGame(); }
}

// --- move logic ---
class MoveError extends Error {}
const fail = msg => { throw new MoveError(msg); };

function evaluateMove(player, placed) {
  if (!Array.isArray(placed) || !placed.length) fail('Neumiestnili ste žiadne písmená.');
  const rack = [...player.rack];
  const tiles = [];
  const seen = new Set();
  for (const t of placed) {
    const r = Number(t.r), c = Number(t.c);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || c < 0 || r >= SIZE || c >= SIZE) fail('Neplatné políčko.');
    if (game.board[r][c] || seen.has(r * SIZE + c)) fail('Políčko je obsadené.');
    seen.add(r * SIZE + c);
    const joker = t.joker === true;
    const idx = rack.indexOf(joker ? '?' : String(t.letter).toUpperCase());
    if (idx < 0) fail('Písmeno nemáte v zásobníku.');
    rack.splice(idx, 1);
    const letter = String(t.letter).toUpperCase();
    if (joker && !(letter in TILES)) fail('Žolík musí zastupovať písmeno slovenskej abecedy.');
    tiles.push({ r, c, l: letter, j: joker });
  }

  const sameRow = tiles.every(t => t.r === tiles[0].r);
  const sameCol = tiles.every(t => t.c === tiles[0].c);
  if (!sameRow && !sameCol) fail('Písmená musia byť v jednom riadku alebo stĺpci.');

  const newAt = new Map(tiles.map(t => [t.r * SIZE + t.c, t]));
  const cell = (r, c) => (r < 0 || c < 0 || r >= SIZE || c >= SIZE) ? null : (newAt.get(r * SIZE + c) || game.board[r][c]);

  // maximal run through (r,c) along direction (dr,dc)
  const run = (r, c, dr, dc) => {
    while (cell(r - dr, c - dc)) { r -= dr; c -= dc; }
    const cells = [];
    while (cell(r, c)) { cells.push({ r, c, t: cell(r, c) }); r += dr; c += dc; }
    return cells;
  };

  const runs = [];
  const addRun = cells => {
    if (cells.length >= 2 && !runs.some(x => x[0].r === cells[0].r && x[0].c === cells[0].c && x.length === cells.length && x[1].r === cells[1].r && x[1].c === cells[1].c)) runs.push(cells);
  };
  if (tiles.length > 1) {
    const [dr, dc, pr, pc] = sameRow ? [0, 1, 1, 0] : [1, 0, 0, 1]; // main direction (right/down) & cross
    const main = run(tiles[0].r, tiles[0].c, dr, dc);
    if (!tiles.every(t => main.some(m => m.r === t.r && m.c === t.c))) fail('Písmená musia tvoriť súvislé slovo bez medzier.');
    addRun(main);
    for (const t of tiles) addRun(run(t.r, t.c, pr, pc));
  } else {
    addRun(run(tiles[0].r, tiles[0].c, 0, 1));
    addRun(run(tiles[0].r, tiles[0].c, 1, 0));
  }
  if (!runs.length) fail('Slovo musí mať aspoň 2 písmená.');

  if (game.firstMove) {
    if (!newAt.has(7 * SIZE + 7)) fail('Prvé slovo musí prechádzať stredovým políčkom.');
  } else if (!runs.some(w => w.some(x => !newAt.has(x.r * SIZE + x.c)))) {
    fail('Slovo sa musí dotýkať už položených písmen.');
  }

  let total = 0;
  const scored = [];
  for (const w of runs) {
    const text = w.map(x => x.t.l).join('').toLowerCase();
    if (!WORDS.has(text)) fail(`Slovo „${text}“ nie je v slovníku.`);
    let sum = 0, mult = 1;
    for (const x of w) {
      let v = x.t.j ? 0 : POINTS[x.t.l];
      if (newAt.has(x.r * SIZE + x.c)) {
        const p = PREMIUM[x.r][x.c];
        if (p === 'DL') v *= 2; else if (p === 'TL') v *= 3;
        else if (p === 'DW') mult *= 2; else if (p === 'TW') mult *= 3;
      }
      sum += v;
    }
    total += sum * mult;
    scored.push({ word: text, points: sum * mult });
  }
  const bingo = tiles.length === RACK;
  if (bingo) total += BINGO;
  return { tiles, rack, words: scored, bingo, points: total };
}

function endTurn() {
  game.turn = (game.turn + 1) % PLAYERS;
}

function finishGame() {
  game.over = true;
  const empty = game.players.findIndex(p => !p.rack.length);
  let bonus = 0;
  for (const p of game.players) {
    const left = p.rack.reduce((s, l) => s + POINTS[l], 0);
    p.score -= left;
    bonus += left;
  }
  if (empty >= 0) game.players[empty].score += bonus;
  const best = Math.max(...game.players.map(p => p.score));
  game.winner = game.players.map((p, i) => p.score === best ? i : -1).filter(i => i >= 0);
  game.log.push({ text: 'Koniec hry.' });
}

function requireTurn(pi) {
  if (!game || game.over) fail('Hra neprebieha.');
  if (pi !== game.turn) fail('Nie ste na ťahu.');
}

const actions = {
  play(pi, body, commit) {
    requireTurn(pi);
    const p = game.players[pi];
    const res = evaluateMove(p, body.tiles);
    if (!commit) return { ok: true, points: res.points, words: res.words, bingo: res.bingo };
    for (const t of res.tiles) game.board[t.r][t.c] = { l: t.l, j: t.j };
    p.rack = res.rack;
    p.score += res.points;
    refill(p);
    game.firstMove = false;
    game.passes = 0;
    game.log.push({ text: `${p.name}: ${res.words.map(w => `${w.word} (${w.points})`).join(', ')}${res.bingo ? ' + 50 bonus' : ''} = ${res.points} b.` });
    if (!p.rack.length && !game.bag.length) finishGame(); else endTurn();
    save();
    return { ok: true, points: res.points };
  },
  name(pi, body) {
    if (!game) fail('Hra neprebieha.');
    const n = String(body.name || '').trim().slice(0, 20);
    if (!n) fail('Meno nesmie byť prázdne.');
    game.players[pi].name = n;
    save();
    return { ok: true };
  },
  pass(pi) {
    requireTurn(pi);
    game.log.push({ text: `${game.players[pi].name} vynecháva ťah.` });
    if (++game.passes >= PLAYERS * 2) finishGame(); else endTurn();
    save();
    return { ok: true };
  },
  exchange(pi, body) {
    requireTurn(pi);
    if (game.bag.length < RACK) fail('Vo vrecúšku je menej ako 7 písmen, výmena nie je možná.');
    const p = game.players[pi];
    const give = [];
    const rack = [...p.rack];
    for (const l of body.letters || []) {
      const i = rack.indexOf(String(l).toUpperCase());
      if (i < 0) fail('Písmeno nemáte v zásobníku.');
      give.push(rack.splice(i, 1)[0]);
    }
    if (!give.length) fail('Vyberte písmená na výmenu.');
    p.rack = rack;
    refill(p);
    game.bag.push(...give);
    for (let i = game.bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [game.bag[i], game.bag[j]] = [game.bag[j], game.bag[i]];
    }
    game.passes++;
    game.log.push({ text: `${p.name} vymenil ${give.length} písmen.` });
    endTurn();
    save();
    return { ok: true };
  },
};

function publicState(pi) {
  return {
    size: SIZE, premium: PREMIUM, points: POINTS, board: game.board, bagCount: game.bag.length,
    players: game.players.map((p, i) => ({ name: p.name, score: p.score, rackCount: p.rack.length, you: i === pi })),
    turn: game.turn, over: game.over, winner: game.winner, log: game.log.slice(-30),
    rack: pi >= 0 && pi < PLAYERS ? game.players[pi].rack : [], seat: pi,
    gameId: game.id, firstMove: game.firstMove,
    tileCount: { letters: Object.values(TILES).reduce((s, v) => s + v[0], 0), jokers: 2 },
  };
}

// --- HTTP ---
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', ch => { data += ch; if (data.length > 1e5) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const p = parseInt(url.searchParams.get('p'), 10);
      return send(res, 200, publicState(Number.isInteger(p) ? p : -1));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      const pi = Number.isInteger(body.player) ? body.player : -1;
      if (url.pathname === '/api/new') { newGame(body.names); return send(res, 200, { ok: true }); }
      if (pi < 0 || pi >= PLAYERS) fail('Neplatný hráč.');
      if (url.pathname === '/api/preview') return send(res, 200, actions.play(pi, body, false));
      const name = url.pathname.slice(5);
      if (!['play', 'pass', 'exchange', 'name'].includes(name)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, actions[name](pi, body, true));
    }
    if (req.method === 'GET') {
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(__dirname, 'public', file);
      if (!full.startsWith(path.join(__dirname, 'public') + path.sep) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(full));
    }
    res.writeHead(405); res.end();
  } catch (e) {
    if (e instanceof MoveError) return send(res, 400, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Chyba servera.' });
  }
});

load();
server.listen(PORT, HOST, () => console.log(`Scrabble: http://${HOST}:${PORT}  (hráči: /?p=0 .. /?p=3)`));
