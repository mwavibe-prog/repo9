const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

// ======================== CONSTANTS ========================

const PORT = 3000;
const GRID_SIZE = 4;
const ROUND_DURATION = 180;
const TOTAL_ROUNDS = 5;

const ROLES = ['water', 'sun', 'seed', 'animal'];
const ROLE_INFO = {
  water:  { name: 'Water Keeper',     icon: '\u{1F4A7}', color: '#2196F3', action: 'water',  desc: 'You control watering. Tap dry plots to water them.' },
  sun:    { name: 'Sun Guide',        icon: '\u{2600}\u{FE0F}', color: '#FF9800', action: 'shade',  desc: 'You control sunlight. Tap scorched plots to add shade.' },
  seed:   { name: 'Seed Planter',     icon: '\u{1F331}', color: '#4CAF50', action: 'plant',  desc: 'You plant new flowers. Tap empty plots to plant seeds.' },
  animal: { name: 'Animal Guardian',  icon: '\u{1F6E1}\u{FE0F}', color: '#795548', action: 'shoo',   desc: 'You protect plants. Tap plots with animals to shoo them.' }
};

const PLANT_TYPES = [
  { type: 'rose',           emoji: '\u{1F339}' },
  { type: 'sunflower',      emoji: '\u{1F33B}' },
  { type: 'tulip',          emoji: '\u{1F337}' },
  { type: 'daisy',          emoji: '\u{1F33C}' },
  { type: 'hibiscus',       emoji: '\u{1F33A}' },
  { type: 'cherry_blossom', emoji: '\u{1F338}' }
];

const STAGE_EMOJI = {
  seed: '\u{1F7EB}',
  sprout: '\u{1F331}',
  growing: '\u{1F33F}',
  bloom: null,
  wilting: '\u{1F940}'
};

const ANIMAL_TYPES = [
  { type: 'rabbit', emoji: '\u{1F430}', name: 'rabbit' },
  { type: 'bird',   emoji: '\u{1F426}', name: 'bird' },
  { type: 'snail',  emoji: '\u{1F40C}', name: 'snail' }
];

const ROW_LABELS = ['A', 'B', 'C', 'D'];

// ======================== STATE ========================

const rooms = new Map();

// ======================== UTILITIES ========================

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return min + Math.floor(Math.random() * (max - min + 1)); }

// ======================== GARDEN LOGIC ========================

function createGarden() {
  const grid = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    grid[r] = [];
    for (let c = 0; c < GRID_SIZE; c++) {
      const hasPlant = Math.random() > 0.3;
      const pt = pick(PLANT_TYPES);
      grid[r][c] = {
        row: r, col: c,
        plant: hasPlant ? { type: pt.type, emoji: pt.emoji, stage: pick(['sprout', 'growing', 'bloom']) } : null,
        moisture: randInt(40, 65),
        sunlight: randInt(40, 65),
        animal: null,
        shaded: false
      };
    }
  }
  return grid;
}

function advancePlants(garden) {
  const stageOrder = ['seed', 'sprout', 'growing', 'bloom'];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const plot = garden[r][c];
      if (plot.plant && plot.plant.stage !== 'wilting') {
        const idx = stageOrder.indexOf(plot.plant.stage);
        if (idx < stageOrder.length - 1 && Math.random() > 0.4) {
          plot.plant.stage = stageOrder[idx + 1];
        }
      }
      // Reset temporary states
      plot.shaded = false;
      // Normalize moisture/sunlight
      plot.moisture = Math.max(20, Math.min(80, plot.moisture + randInt(-5, 5)));
      plot.sunlight = Math.max(20, Math.min(80, plot.sunlight + randInt(-5, 5)));
    }
  }
}

function getPlotEmoji(plot) {
  if (!plot.plant) return '';
  if (plot.plant.stage === 'bloom') return plot.plant.emoji;
  return STAGE_EMOJI[plot.plant.stage] || '';
}

function findPlots(garden, filter) {
  const plots = [];
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++)
      if (filter(garden[r][c])) plots.push(garden[r][c]);
  return plots;
}

// ======================== PROBLEM & CLUE GENERATION ========================

function generateProblems(game) {
  const problems = [];
  const playerCount = game.players.size;
  const baseCount = Math.max(1, Math.floor(playerCount / 4));
  const perRole = Math.min(baseCount + Math.floor(game.round / 2), 3);

  const usedPlots = new Set();
  function markUsed(r, c) { usedPlots.add(`${r},${c}`); }
  function isUsed(r, c) { return usedPlots.has(`${r},${c}`); }

  // Water problems
  const wetPlots = findPlots(game.garden, p => p.plant && !isUsed(p.row, p.col));
  for (let i = 0; i < perRole && wetPlots.length > 0; i++) {
    const idx = randInt(0, wetPlots.length - 1);
    const plot = wetPlots.splice(idx, 1)[0];
    plot.moisture = randInt(10, 25);
    markUsed(plot.row, plot.col);
    problems.push({
      id: `w${problems.length}`, type: 'NEEDS_WATER', role: 'water',
      row: plot.row, col: plot.col,
      clue: makeClue('NEEDS_WATER', plot, game),
      solved: false
    });
  }

  // Sun problems
  const sunPlots = findPlots(game.garden, p => p.plant && !isUsed(p.row, p.col));
  for (let i = 0; i < perRole && sunPlots.length > 0; i++) {
    const idx = randInt(0, sunPlots.length - 1);
    const plot = sunPlots.splice(idx, 1)[0];
    plot.sunlight = randInt(80, 100);
    markUsed(plot.row, plot.col);
    problems.push({
      id: `s${problems.length}`, type: 'NEEDS_SHADE', role: 'sun',
      row: plot.row, col: plot.col,
      clue: makeClue('NEEDS_SHADE', plot, game),
      solved: false
    });
  }

  // Animal problems
  const animalPlots = findPlots(game.garden, p => p.plant && !isUsed(p.row, p.col));
  for (let i = 0; i < perRole && animalPlots.length > 0; i++) {
    const idx = randInt(0, animalPlots.length - 1);
    const plot = animalPlots.splice(idx, 1)[0];
    const animal = pick(ANIMAL_TYPES);
    plot.animal = animal.type;
    markUsed(plot.row, plot.col);
    problems.push({
      id: `a${problems.length}`, type: 'ANIMAL_ALERT', role: 'animal',
      row: plot.row, col: plot.col,
      clue: makeClue('ANIMAL_ALERT', plot, game),
      solved: false
    });
  }

  // Seed problems
  const emptyPlots = findPlots(game.garden, p => !p.plant && !isUsed(p.row, p.col));
  for (let i = 0; i < perRole && emptyPlots.length > 0; i++) {
    const idx = randInt(0, emptyPlots.length - 1);
    const plot = emptyPlots.splice(idx, 1)[0];
    markUsed(plot.row, plot.col);
    problems.push({
      id: `p${problems.length}`, type: 'READY_TO_PLANT', role: 'seed',
      row: plot.row, col: plot.col,
      clue: makeClue('READY_TO_PLANT', plot, game),
      solved: false
    });
  }

  return problems;
}

function makeClue(type, plot, game) {
  const label = `${ROW_LABELS[plot.row]}${plot.col + 1}`;
  const animalEmoji = plot.animal === 'rabbit' ? '\u{1F430}' : plot.animal === 'bird' ? '\u{1F426}' : '\u{1F40C}';

  // Simple, short clues for all rounds - easy for elderly to read
  if (game.round <= 2) {
    switch (type) {
      case 'NEEDS_WATER':
        return `\u{1F4A7} Water ${label}`;
      case 'NEEDS_SHADE':
        return `\u{2600}\u{FE0F} Shade ${label}`;
      case 'ANIMAL_ALERT':
        return `${animalEmoji} Shoo at ${label}`;
      case 'READY_TO_PLANT':
        return `\u{1F331} Plant at ${label}`;
    }
  } else if (game.round <= 4) {
    // Slightly more descriptive but still short
    const posWords = [];
    if (plot.row === 0) posWords.push('top');
    if (plot.row === GRID_SIZE - 1) posWords.push('bottom');
    if (plot.col === 0) posWords.push('left');
    if (plot.col === GRID_SIZE - 1) posWords.push('right');
    const where = posWords.length ? posWords.join('-') : 'middle';

    switch (type) {
      case 'NEEDS_WATER':
        return `\u{1F4A7} ${label} is dry! (${where})`;
      case 'NEEDS_SHADE':
        return `\u{2600}\u{FE0F} ${label} too hot! (${where})`;
      case 'ANIMAL_ALERT':
        return `${animalEmoji} at ${label}! (${where})`;
      case 'READY_TO_PLANT':
        return `\u{1F331} Empty at ${label} (${where})`;
    }
  } else {
    // Round 5: use neighbor hints for mind exercise
    const hint = getNeighborHint(plot, game.garden);
    switch (type) {
      case 'NEEDS_WATER':
        return `\u{1F4A7} Dry! ${hint}`;
      case 'NEEDS_SHADE':
        return `\u{2600}\u{FE0F} Hot! ${hint}`;
      case 'ANIMAL_ALERT':
        return `${animalEmoji} ${hint}`;
      case 'READY_TO_PLANT':
        return `\u{1F331} Empty! ${hint}`;
    }
  }
  return `Check ${label}`;
}

function getNeighborHint(plot, garden) {
  const dirs = [[-1,0,'above'],[1,0,'below'],[0,-1,'left of'],[0,1,'right of']];
  for (const [dr, dc, desc] of dirs) {
    const nr = plot.row + dr, nc = plot.col + dc;
    if (nr >= 0 && nr < GRID_SIZE && nc >= 0 && nc < GRID_SIZE) {
      const n = garden[nr][nc];
      if (n.plant && n.plant.stage === 'bloom') {
        return `${desc} the ${n.plant.emoji}`;
      }
    }
  }
  for (const [dr, dc, desc] of dirs) {
    const nr = plot.row + dr, nc = plot.col + dc;
    if (nr >= 0 && nr < GRID_SIZE && nc >= 0 && nc < GRID_SIZE) {
      const n = garden[nr][nc];
      if (n.plant) {
        return `${desc} a \u{1F33F}`;
      }
    }
  }
  const label = `${ROW_LABELS[plot.row]}${plot.col + 1}`;
  return `at ${label}`;
}

// ======================== ACTION PROCESSING ========================

function processAction(game, socketId, row, col) {
  const player = game.players.get(socketId);
  if (!player) return { success: false, msg: 'Player not found.' };

  if (row < 0 || row >= GRID_SIZE || col < 0 || col >= GRID_SIZE)
    return { success: false, msg: 'Invalid plot.' };

  const plot = game.garden[row][col];
  const role = player.role;
  const actionType = ROLE_INFO[role].action;

  // Find matching unsolved problem
  const problem = game.problems.find(p =>
    !p.solved && p.row === row && p.col === col && p.role === role
  );

  if (problem) {
    problem.solved = true;
    applyCorrectAction(plot, actionType);
    game.score += 10;
    game.health = Math.min(100, game.health + 2);
    // Speed bonus: within first 60 seconds
    if (game.roundTimeLeft > ROUND_DURATION - 60) game.score += 5;

    return {
      success: true,
      msg: pick(['Good job!', 'Well done!', 'Nice!', 'Yes!']),
      sparkle: true
    };
  } else {
    // Wrong action
    game.health = Math.max(0, game.health - 3);
    return {
      success: false,
      msg: pick([
        'Not this one. Try again!',
        'Oops! Wrong spot.',
        'Check your clues!',
        'Try another spot!'
      ])
    };
  }
}

function applyCorrectAction(plot, actionType) {
  switch (actionType) {
    case 'water':
      plot.moisture = 55;
      if (plot.plant && plot.plant.stage === 'wilting') plot.plant.stage = 'growing';
      break;
    case 'shade':
      plot.sunlight = 50;
      plot.shaded = true;
      break;
    case 'shoo':
      plot.animal = null;
      break;
    case 'plant':
      const pt = pick(PLANT_TYPES);
      plot.plant = { type: pt.type, emoji: pt.emoji, stage: 'seed' };
      plot.moisture = 50;
      plot.sunlight = 50;
      break;
  }
}

// ======================== GAME FLOW ========================

function startRound(game) {
  game.round++;
  game.roundTimeLeft = ROUND_DURATION;

  if (game.round > 1) advancePlants(game.garden);

  game.problems = generateProblems(game);

  // Build serializable garden
  const gardenData = serializeGarden(game.garden);

  // Notify TV
  io.to(game.tvSocketId).emit('round-start', {
    round: game.round,
    totalRounds: TOTAL_ROUNDS,
    garden: gardenData,
    health: game.health,
    score: game.score,
    duration: ROUND_DURATION,
    problems: game.problems.map(p => ({
      id: p.id, type: p.type, row: p.row, col: p.col, role: p.role, solved: p.solved
    }))
  });

  // Notify each player with role-specific clues
  for (const [sid, player] of game.players) {
    const clues = game.problems
      .filter(p => p.role === player.role)
      .map(p => ({ id: p.id, clue: p.clue, solved: p.solved, row: p.row, col: p.col }));

    io.to(sid).emit('round-start', {
      round: game.round,
      totalRounds: TOTAL_ROUNDS,
      clues,
      garden: gardenData,
      duration: ROUND_DURATION,
      health: game.health,
      score: game.score
    });
  }

  // Timer
  game.roundTimer = setInterval(() => {
    game.roundTimeLeft--;
    if (game.roundTimeLeft <= 0) {
      endRound(game);
    }
  }, 1000);
}

function endRound(game) {
  if (game.roundTimer) { clearInterval(game.roundTimer); game.roundTimer = null; }

  const unsolved = game.problems.filter(p => !p.solved).length;
  game.health = Math.max(0, game.health - unsolved * 5);

  // Wilt unsolved plant problems
  for (const prob of game.problems) {
    if (!prob.solved && prob.type !== 'READY_TO_PLANT') {
      const plot = game.garden[prob.row][prob.col];
      if (plot.plant) plot.plant.stage = 'wilting';
    }
  }

  const solved = game.problems.filter(p => p.solved).length;
  if (solved === game.problems.length && game.problems.length > 0) game.score += 20;

  const result = {
    round: game.round,
    totalRounds: TOTAL_ROUNDS,
    solved,
    total: game.problems.length,
    score: game.score,
    health: game.health,
    garden: serializeGarden(game.garden)
  };

  io.to(game.code).emit('round-end', result);

  if (game.round >= TOTAL_ROUNDS || game.health <= 0) {
    setTimeout(() => endGame(game), 6000);
  } else {
    setTimeout(() => {
      if (game.state === 'playing') startRound(game);
    }, 7000);
  }
}

function endGame(game) {
  game.state = 'gameOver';
  if (game.roundTimer) { clearInterval(game.roundTimer); game.roundTimer = null; }

  let rating;
  if (game.score >= 400)      rating = { name: 'Paradise Garden',    emoji: '\u{1F308}', stars: 5 };
  else if (game.score >= 280) rating = { name: 'Beautiful Blooms',   emoji: '\u{1F338}', stars: 4 };
  else if (game.score >= 170) rating = { name: 'Growing Garden',     emoji: '\u{1F33F}', stars: 3 };
  else if (game.score >= 80)  rating = { name: 'Struggling Sprouts', emoji: '\u{1F331}', stars: 2 };
  else                        rating = { name: 'Dry Desert',         emoji: '\u{1F3DC}\u{FE0F}', stars: 1 };

  const win = game.health > 50;

  io.to(game.code).emit('game-over', {
    score: game.score,
    health: game.health,
    rating,
    win,
    garden: serializeGarden(game.garden),
    message: win
      ? 'Congratulations! Your garden is thriving!'
      : 'The garden needs more care. Try again!'
  });
}

function serializeGarden(garden) {
  return garden.map(row => row.map(plot => ({
    row: plot.row, col: plot.col,
    plant: plot.plant,
    moisture: plot.moisture,
    sunlight: plot.sunlight,
    animal: plot.animal,
    shaded: plot.shaded,
    displayEmoji: getPlotEmoji(plot)
  })));
}

// ======================== SOCKET HANDLERS ========================

io.on('connection', (socket) => {

  // TV creates a room
  socket.on('create-room', async () => {
    const code = generateRoomCode();
    const ip = getLocalIP();
    const joinUrl = `http://${ip}:${PORT}/phone.html?room=${code}`;

    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 280, margin: 1, color: { dark: '#2E4F1F', light: '#FFFFFF' } });
    } catch (e) { console.error('QR error:', e); }

    const game = {
      code,
      tvSocketId: socket.id,
      players: new Map(),
      state: 'lobby',
      round: 0,
      garden: null,
      health: 100,
      score: 0,
      problems: [],
      roundTimer: null,
      roundTimeLeft: 0
    };

    rooms.set(code, game);
    socket.join(code);
    socket.roomCode = code;

    socket.emit('room-created', { code, qrDataUrl, joinUrl });
    console.log(`Room ${code} created`);
  });

  // Player joins
  socket.on('join-room', ({ code, name }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const game = rooms.get(roomCode);

    if (!game) return socket.emit('join-error', { message: 'Room not found. Check the code and try again.' });
    if (game.state !== 'lobby') return socket.emit('join-error', { message: 'Game already started. Wait for next game.' });
    if (game.players.size >= 15) return socket.emit('join-error', { message: 'Room is full! (max 15 players)' });

    const roleIndex = game.players.size % ROLES.length;
    const role = ROLES[roleIndex];
    const info = ROLE_INFO[role];

    const player = { id: socket.id, name: name.trim() || 'Player', role, score: 0 };
    game.players.set(socket.id, player);
    socket.join(roomCode);
    socket.roomCode = roomCode;

    socket.emit('joined', {
      role, roleName: info.name, roleColor: info.color,
      roleIcon: info.icon, roleDesc: info.desc, playerName: player.name
    });

    // Notify TV
    io.to(game.tvSocketId).emit('player-joined', { players: getPlayerList(game) });
    console.log(`${player.name} joined ${roomCode} as ${info.name}`);
  });

  // TV starts game
  socket.on('start-game', () => {
    const game = rooms.get(socket.roomCode);
    if (!game || game.tvSocketId !== socket.id || game.state !== 'lobby') return;
    if (game.players.size < 1) {
      return socket.emit('game-error', { message: 'Need at least 1 player to start.' });
    }

    game.state = 'playing';
    game.garden = createGarden();

    // Tell everyone game is starting
    io.to(game.code).emit('game-starting', { players: getPlayerList(game), totalRounds: TOTAL_ROUNDS });

    setTimeout(() => startRound(game), 3000);
  });

  // Player action
  socket.on('player-action', ({ row, col }) => {
    const game = rooms.get(socket.roomCode);
    if (!game || game.state !== 'playing') return;

    const result = processAction(game, socket.id, row, col);
    socket.emit('action-feedback', result);

    // Update TV with garden state and action info
    const player = game.players.get(socket.id);
    io.to(game.tvSocketId).emit('garden-update', {
      garden: serializeGarden(game.garden),
      health: game.health,
      score: game.score,
      problems: game.problems.map(p => ({ id: p.id, type: p.type, row: p.row, col: p.col, role: p.role, solved: p.solved })),
      action: {
        success: result.success,
        row, col,
        role: player ? player.role : '',
        playerName: player ? player.name : '',
        sparkle: result.sparkle || false
      }
    });

    // Update all players with solved status
    for (const [sid, pl] of game.players) {
      const clues = game.problems
        .filter(p => p.role === pl.role)
        .map(p => ({ id: p.id, clue: p.clue, solved: p.solved, row: p.row, col: p.col }));
      io.to(sid).emit('clues-update', { clues, health: game.health, score: game.score });
    }

    // All solved?
    if (game.problems.length > 0 && game.problems.every(p => p.solved)) {
      game.score += 20;
      setTimeout(() => endRound(game), 2000);
    }
  });

  // Request time
  socket.on('get-time', () => {
    const game = rooms.get(socket.roomCode);
    if (game) socket.emit('time-sync', { timeLeft: game.roundTimeLeft });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const game = rooms.get(socket.roomCode);
    if (!game) return;

    if (socket.id === game.tvSocketId) {
      if (game.roundTimer) clearInterval(game.roundTimer);
      io.to(game.code).emit('game-error', { message: 'TV disconnected. Game ended.' });
      rooms.delete(game.code);
      console.log(`Room ${game.code} closed (TV disconnected)`);
    } else {
      game.players.delete(socket.id);
      io.to(game.tvSocketId).emit('player-joined', { players: getPlayerList(game) });
    }
  });
});

function getPlayerList(game) {
  return Array.from(game.players.values()).map(p => ({
    name: p.name, role: p.role,
    roleName: ROLE_INFO[p.role].name,
    roleIcon: ROLE_INFO[p.role].icon,
    roleColor: ROLE_INFO[p.role].color
  }));
}

// ======================== START ========================

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('='.repeat(50));
  console.log('  GARDEN GUARDIANS - Multiplayer Garden Game');
  console.log('='.repeat(50));
  console.log(`  TV Screen:  http://${ip}:${PORT}/tv.html`);
  console.log(`  Players:    http://${ip}:${PORT}/phone.html`);
  console.log(`  Local:      http://localhost:${PORT}`);
  console.log('='.repeat(50));
  console.log('');
});
