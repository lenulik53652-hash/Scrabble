// Slovak Scrabble for 2–4 players - dependency-free Node HTTP server.
// Game state is persisted to Turso when configured, with a local JSON fallback.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'data', 'state.json');
const TURSO_DATABASE_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const TURSO_AUTH_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();
const TURSO_CONFIGURED = Boolean(TURSO_DATABASE_URL && (TURSO_AUTH_TOKEN || TURSO_DATABASE_URL.startsWith('file:')));
const CLOUD_STATE_TABLE = 'scrabble_game_state';
const SIZE = 15, RACK = 7, BINGO = 50, MIN_PLAYERS = 2, MAX_PLAYERS = 4;

// Slovak tile distribution; Q and W are intentionally not included.
const TILES = {
  A: [9, 1], E: [8, 1], I: [6, 1], N: [5, 1], O: [10, 1], S: [5, 1], T: [4, 1], V: [5, 1],
  B: [2, 2], 'Á': [2, 2], D: [3, 2], J: [2, 2], K: [4, 2], L: [4, 2], M: [3, 2], P: [3, 2], R: [5, 2], U: [3, 2], Y: [2, 2], Z: [2, 2],
  C: [1, 3], 'Č': [1, 3], 'É': [1, 3], H: [1, 3], 'Í': [1, 3], 'Š': [1, 3], 'Ú': [1, 3], 'Ý': [1, 3], 'Ž': [1, 3],
  'Ť': [1, 4], 'Ľ': [1, 5], F: [1, 6], G: [1, 6], 'Ň': [1, 7], 'Ô': [1, 7],
  'Ä': [1, 8], 'Ď': [1, 8], 'Ó': [1, 8], 'Ĺ': [1, 9], 'Ŕ': [1, 9], X: [1, 9],
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
let WORDS = new Set();

function loadDictionary() {
  WORDS = new Set(fs.readFileSync(path.join(__dirname, 'data', 'words.txt'), 'utf8').split('\n').filter(Boolean));
  console.log(`Dictionary: ${WORDS.size} words`);
}

// --- game state ---
let game = null;
let turso = null;
let cloudConnected = false;
let cloudError = null;
let cloudWritesPending = 0;
let cloudWriteQueue = Promise.resolve();
let initialized = false;

function withTimeout(promise, timeoutMs, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

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

function createLobby(playerCount = 2) {
  const count = Number(playerCount);
  if (!Number.isInteger(count) || count < MIN_PLAYERS || count > MAX_PLAYERS) {
    fail(`Počet hráčov musí byť od ${MIN_PLAYERS} do ${MAX_PLAYERS}.`);
  }
  game = {
    id: Date.now(),
    phase: 'lobby',
    capacity: count,
    board: Array.from({ length: SIZE }, () => Array(SIZE).fill(null)), // {l: letter, j: isJoker}
    bag: [],
    players: Array.from({ length: count }, (_, i) => ({
      name: '', tokenHash: null, rack: [], rackRevision: 0, score: 0,
    })),
    turn: 0, firstMove: true, passes: 0, over: false, winner: null, log: [], revision: 0,
  };
  game.log.push({ text: `Čaká sa na ${count} hráčov. Pridajte sa pomocou tlačidla +.` });
  save();
}

function startGame() {
  if (!game || game.phase !== 'lobby') fail('Hra už bola spustená.');
  if (game.players.some(p => !p.tokenHash || !p.name.trim())) fail('Hru možno spustiť až po pripojení všetkých hráčov a zadaní ich mien.');
  game.phase = 'playing';
  game.bag = newBag();
  game.players.forEach(player => {
    refill(player);
    player.rackRevision++;
  });
  game.turn = Math.floor(Math.random() * game.players.length);
  game.log.push({ text: `Hra sa začala. Hrá ${game.players.length} hráčov.` });
  save();
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function resolvePlayer(token) {
  if (!game || !token) return -1;
  const supplied = tokenHash(token);
  return game.players.findIndex(player => player.tokenHash && crypto.timingSafeEqual(Buffer.from(player.tokenHash), Buffer.from(supplied)));
}

function joinGame(name, token, requestedSeat) {
  if (!game || game.phase !== 'lobby') fail('Do tejto hry sa už nemožno pridať. Požiadajte o novú hru.');
  const cleanName = String(name || '').trim().slice(0, 20);
  if (!cleanName) fail('Zadajte svoje meno.');
  const existingSeat = resolvePlayer(token);
  if (existingSeat >= 0) return { seat: existingSeat, token, name: game.players[existingSeat].name };
  const firstOpenSeat = game.players.findIndex(player => !player.tokenHash);
  const seat = Number.isInteger(requestedSeat) ? requestedSeat : firstOpenSeat;
  if (seat < 0 || seat >= game.players.length || game.players[seat].tokenHash) fail('Toto miesto už nie je voľné. Vyberte iné miesto.');
  const playerToken = crypto.randomBytes(32).toString('base64url');
  game.players[seat].name = cleanName;
  game.players[seat].tokenHash = tokenHash(playerToken);
  game.log.push({ text: `${cleanName} sa pridal(a) k hre (${seat + 1}/${game.capacity}).` });
  save();
  return { seat, token: playerToken, name: cleanName };
}

function addLobbySeat(token) {
  if (resolvePlayer(token) < 0) fail('Najprv sa pridajte k hre.');
  if (!game || game.phase !== 'lobby') fail('Po začiatku hry už nemožno pridať miesto.');
  if (game.players.length >= MAX_PLAYERS) fail(`Pri stole môžu hrať najviac ${MAX_PLAYERS} hráči.`);
  const seat = game.players.length;
  game.players.push({ name: '', tokenHash: null, rack: [], rackRevision: 0, score: 0 });
  game.capacity = game.players.length;
  game.log.push({ text: `Pridané miesto pre hráča ${seat + 1} (${game.capacity}/${MAX_PLAYERS} miest).` });
  save();
  return { ok: true, seat, capacity: game.capacity };
}

function save() {
  game.revision = (game.revision || 0) + 1;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(game));
  if (!turso) return Promise.resolve();

  const snapshot = JSON.stringify(game);
  const savedAt = new Date().toISOString();
  cloudWritesPending++;
  cloudWriteQueue = cloudWriteQueue.then(async () => {
    await withTimeout(ensureCloudTable(), 8000, 'Turso table setup');
    await withTimeout(turso.execute({
      sql: `INSERT INTO ${CLOUD_STATE_TABLE} (id, state_json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      args: [snapshot, savedAt],
    }), 8000, 'Turso game save');
    cloudConnected = true;
    cloudError = null;
  }).catch(error => {
    cloudConnected = false;
    cloudError = error;
    console.error('Turso save failed; local save remains available. Check the private Render environment settings.');
  }).finally(() => { cloudWritesPending--; });
  return cloudWriteQueue;
}

async function ensureCloudTable() {
  await turso.execute(`CREATE TABLE IF NOT EXISTS ${CLOUD_STATE_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), state_json TEXT NOT NULL, updated_at TEXT NOT NULL)`);
}

async function load() {
  if (TURSO_CONFIGURED) {
    turso = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN || undefined });
    try {
      await withTimeout(ensureCloudTable(), 8000, 'Turso table setup');
      const result = await withTimeout(turso.execute(`SELECT state_json FROM ${CLOUD_STATE_TABLE} WHERE id = 1`), 8000, 'Turso game load');
      if (result.rows.length) {
        game = JSON.parse(result.rows[0].state_json);
        migrateGameState();
        await cloudWriteQueue;
        cloudConnected = true;
        cloudError = null;
        console.log('Game state loaded from Turso cloud database.');
        return;
      }
      cloudConnected = true;
      console.log('Turso is connected; no saved game found yet.');
    } catch (error) {
      cloudConnected = false;
      cloudError = error;
      console.error('Turso unavailable; trying local game state. Check the private Render environment settings.');
    }
  } else if (TURSO_DATABASE_URL || TURSO_AUTH_TOKEN) {
    cloudError = new Error('Both TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.');
    console.error(cloudError.message);
  }

  try {
    game = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    migrateGameState();
    if (turso) await save(); // Migrate the existing local game into a newly configured database.
  } catch {
    createLobby(2);
    await cloudWriteQueue;
  }
}

function migrateGameState() {
  if (!game || !Array.isArray(game.players)) {
    createLobby(2);
    return;
  }
  if (game.phase && game.capacity && game.players.every(player => Object.hasOwn(player, 'tokenHash'))) return;
  // Existing games used shareable ?p= seat numbers. Reset to a private-token lobby rather than allowing seat switching.
  createLobby(2);
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
  game.turn = (game.turn + 1) % game.players.length;
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
  if (!game || game.phase !== 'playing' || game.over) fail('Hra ešte neprebieha. Počkajte, kým sa všetci hráči pripoja a hra sa spustí.');
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
    p.rackRevision++;
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
    if (!game || game.phase !== 'lobby') fail('Meno už nemožno meniť po začiatku hry.');
    const n = String(body.name || '').trim().slice(0, 20);
    if (!n) fail('Meno nesmie byť prázdne.');
    game.players[pi].name = n;
    save();
    return { ok: true };
  },
  pass(pi) {
    requireTurn(pi);
    game.log.push({ text: `${game.players[pi].name} vynecháva ťah.` });
    if (++game.passes >= game.players.length * 2) finishGame(); else endTurn();
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
    p.rackRevision++;
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
    players: game.players.map((p, i) => ({ name: p.name, joined: Boolean(p.tokenHash), score: p.score, rackCount: p.rack.length, rackRevision: p.rackRevision || 0, you: i === pi })),
    turn: game.turn, over: game.over, phase: game.phase, winner: game.winner, log: game.log.slice(-30),
    rack: pi >= 0 && pi < game.players.length ? game.players[pi].rack : [], seat: pi,
    playerCount: game.players.length, capacity: game.capacity,
    gameId: game.id, revision: game.revision || 0, firstMove: game.firstMove,
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
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, { ok: true, status: initialized ? 'ready' : 'starting' });
    }
    if (req.method === 'GET' && url.pathname === '/api/storage') {
      return send(res, 200, {
        provider: TURSO_CONFIGURED ? 'turso' : 'local',
        configured: TURSO_CONFIGURED,
        connected: cloudConnected,
        pendingWrites: cloudWritesPending,
        detail: cloudError ? 'Cloud save is unavailable; local backup is active.' : null,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      if (!initialized) return send(res, 503, { error: 'Hra sa spúšťa, skúste to o chvíľu.' });
      const seat = resolvePlayer(req.headers['x-player-token']);
      return send(res, 200, publicState(seat));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (!initialized) return send(res, 503, { error: 'Hra sa spúšťa, skúste to o chvíľu.' });
      const body = await readBody(req);
      const pi = resolvePlayer(req.headers['x-player-token']);
      if (url.pathname === '/api/new') {
        createLobby(body.playerCount);
        await cloudWriteQueue;
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/join') {
        const result = joinGame(body.name, req.headers['x-player-token'], Number.isInteger(body.seat) ? body.seat : undefined);
        await cloudWriteQueue;
        return send(res, 200, result);
      }
      if (url.pathname === '/api/add-seat') {
        const result = addLobbySeat(req.headers['x-player-token']);
        await cloudWriteQueue;
        return send(res, 200, result);
      }
      if (url.pathname === '/api/start') {
        if (pi < 0) fail('Najprv sa pridajte k hre.');
        startGame();
        await cloudWriteQueue;
        return send(res, 200, { ok: true });
      }
      if (pi < 0 || pi >= game.players.length) fail('Vyberte platné miesto pri stole.');
      if (url.pathname === '/api/preview') return send(res, 200, actions.play(pi, body, false));
      const name = url.pathname.slice(5);
      if (!['play', 'pass', 'exchange', 'name'].includes(name)) return send(res, 404, { error: 'Not found' });
      const result = actions[name](pi, body, true);
      await cloudWriteQueue;
      return send(res, 200, result);
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

server.listen(PORT, HOST, async () => {
  console.log(`Scrabble listening on ${HOST}:${PORT}; initializing game data...`);
  try {
    loadDictionary();
    await load();
    initialized = true;
    const storage = TURSO_CONFIGURED ? (cloudConnected ? 'Turso cloud' : 'Turso configured, using local fallback') : 'local JSON';
    console.log(`Scrabble is ready (úložisko: ${storage}).`);
  } catch (error) {
    console.error('Game initialization failed:', error);
  }
});
