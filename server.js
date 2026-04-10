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
  water:  { name: 'Water Keeper',    icon: '\u{1F4A7}', color: '#2196F3', desc: 'Water dry plants. Pick the right amount!' },
  sun:    { name: 'Sun Guide',       icon: '\u{2600}\u{FE0F}', color: '#FF9800', desc: 'Add shade to hot plants. Pick the right amount!' },
  seed:   { name: 'Seed Planter',    icon: '\u{1F331}', color: '#4CAF50', desc: 'Plant seeds in empty soil. Pick the right amount!' },
  animal: { name: 'Animal Guardian', icon: '\u{1F6E1}\u{FE0F}', color: '#795548', desc: 'Shoo animals away. Pick the right amount!' }
};

const PLANT_TYPES = [
  { type: 'rose', emoji: '\u{1F339}' },
  { type: 'sunflower', emoji: '\u{1F33B}' },
  { type: 'tulip', emoji: '\u{1F337}' },
  { type: 'daisy', emoji: '\u{1F33C}' },
  { type: 'hibiscus', emoji: '\u{1F33A}' },
  { type: 'cherry_blossom', emoji: '\u{1F338}' }
];

const STAGE_EMOJI = { seed: '\u{1F7EB}', sprout: '\u{1F331}', growing: '\u{1F33F}', bloom: null, wilting: '\u{1F940}' };
const ANIMAL_TYPES = ['rabbit', 'bird', 'snail'];
const ANIMAL_EMOJI = { rabbit: '\u{1F430}', bird: '\u{1F426}', snail: '\u{1F40C}' };
const ROW_LABELS = ['A', 'B', 'C', 'D'];

// Action button configs per role
const ACTION_BUTTONS = {
  water:  ['\u{1F4A7}', '\u{1F4A7}\u{1F4A7}', '\u{1F4A7}\u{1F4A7}\u{1F4A7}'],
  sun:    ['\u{2600}\u{FE0F}', '\u{2600}\u{FE0F}\u{2600}\u{FE0F}', '\u{2600}\u{FE0F}\u{2600}\u{FE0F}\u{2600}\u{FE0F}'],
  seed:   ['\u{1F331}', '\u{1F331}\u{1F331}', '\u{1F331}\u{1F331}\u{1F331}'],
  animal: ['\u{1F43E}', '\u{1F43E}\u{1F43E}', '\u{1F43E}\u{1F43E}\u{1F43E}']
};
const ACTION_LABELS = ['A little', 'Some', 'A lot'];

// ======================== STATE ========================

const rooms = new Map();

// ======================== UTILITIES ========================

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = ''; for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)]; } while (rooms.has(code));
  return code;
}
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const n of Object.keys(ifaces)) for (const i of ifaces[n]) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }

// ======================== GARDEN ========================

function createGarden() {
  const grid = [];
  for (let r = 0; r < GRID_SIZE; r++) {
    grid[r] = [];
    for (let c = 0; c < GRID_SIZE; c++) {
      const hasPlant = Math.random() > 0.25;
      const pt = pick(PLANT_TYPES);
      grid[r][c] = {
        row: r, col: c,
        plant: hasPlant ? { type: pt.type, emoji: pt.emoji, stage: pick(['sprout', 'growing', 'bloom']) } : null,
        moisture: randInt(45, 65),
        sunlight: randInt(40, 60),
        animal: null,
        shaded: false
      };
    }
  }
  return grid;
}

function advancePlants(garden) {
  const order = ['seed', 'sprout', 'growing', 'bloom'];
  for (let r = 0; r < GRID_SIZE; r++) {
    for (let c = 0; c < GRID_SIZE; c++) {
      const p = garden[r][c];
      if (p.plant && p.plant.stage !== 'wilting') {
        const idx = order.indexOf(p.plant.stage);
        if (idx < order.length - 1 && Math.random() > 0.4) p.plant.stage = order[idx + 1];
      }
      p.shaded = false;
      p.moisture = Math.max(25, Math.min(75, p.moisture + randInt(-5, 5)));
      p.sunlight = Math.max(25, Math.min(70, p.sunlight + randInt(-5, 5)));
    }
  }
}

function getPlotEmoji(plot) {
  if (!plot.plant) return '';
  if (plot.plant.stage === 'bloom') return plot.plant.emoji;
  return STAGE_EMOJI[plot.plant.stage] || '';
}

function serializeGarden(garden) {
  return garden.map(row => row.map(p => ({
    row: p.row, col: p.col, plant: p.plant,
    moisture: p.moisture, sunlight: p.sunlight,
    animal: p.animal, shaded: p.shaded,
    displayEmoji: getPlotEmoji(p)
  })));
}

// ======================== PROBLEM & CLUE GENERATION ========================

function makeProblemsForPlayer(game, player, usedByRole) {
  const count = Math.min(1 + game.round, 4); // round1=2, round2=3, round3=4, round4=4, round5=4
  const problems = [];
  const role = player.role;
  const used = usedByRole[role];

  for (let i = 0; i < count; i++) {
    let plot;
    if (role === 'seed') {
      plot = findAvailablePlot(game.garden, p => !p.plant && !used.has(p.row + ',' + p.col));
      if (!plot) plot = findAvailablePlot(game.garden, p => !p.plant); // allow reuse
    } else {
      plot = findAvailablePlot(game.garden, p => p.plant && !used.has(p.row + ',' + p.col));
      if (!plot) plot = findAvailablePlot(game.garden, p => p.plant);
    }
    if (!plot) break;

    used.add(plot.row + ',' + plot.col);
    const level = randInt(1, 3);
    const clue = makeClue(role, level, game.round);

    // Apply the problem visually to the garden
    applyProblemToGarden(plot, role, level);

    problems.push({
      plotRow: plot.row, plotCol: plot.col,
      plotLabel: ROW_LABELS[plot.row] + (plot.col + 1),
      plotEmoji: getPlotEmoji(plot),
      level,
      clueText: clue.text,
      clueHint: clue.hint,
      solved: false,
      result: null
    });
  }
  return problems;
}

function findAvailablePlot(garden, filter) {
  const candidates = [];
  for (let r = 0; r < GRID_SIZE; r++)
    for (let c = 0; c < GRID_SIZE; c++)
      if (filter(garden[r][c])) candidates.push(garden[r][c]);
  return candidates.length > 0 ? pick(candidates) : null;
}

function applyProblemToGarden(plot, role, level) {
  switch (role) {
    case 'water': plot.moisture = [30, 18, 5][level - 1]; break;
    case 'sun': plot.sunlight = [72, 86, 100][level - 1]; break;
    case 'animal':
      plot.animal = pick(ANIMAL_TYPES);
      break;
    // seed: plot already empty, no change needed
  }
}

function makeClue(role, level, round) {
  if (round <= 2) {
    // EASY: direct words + visual hint
    const texts = {
      water:  ['A bit dry', 'Quite dry', 'Very dry!'],
      sun:    ['A bit hot', 'Quite hot', 'Very hot!'],
      seed:   ['Small spot', 'Some space', 'Big space!'],
      animal: ['Far away', 'Getting close', 'Very close!']
    };
    return { text: texts[role][level - 1], hint: ACTION_BUTTONS[role][level - 1] };
  } else if (round <= 4) {
    // MEDIUM: descriptive, visual hint removed
    const texts = {
      water: ['Top soil is a little dry', 'Soil is dry halfway down', 'Soil is cracking!'],
      sun:   ['Leaves feel warm', 'Leaves are getting hot', 'Leaves are burning!'],
      seed:  ['A tiny gap here', 'A nice open spot', 'A big empty area!'],
      animal:['Something watching from far', 'An animal walking over', 'An animal is right here!']
    };
    return { text: texts[role][level - 1], hint: '' };
  } else {
    // ROUND 5: a bit more puzzle-like
    const texts = {
      water: ['One small crack in the soil', 'A few cracks in the soil', 'The ground is full of cracks!'],
      sun:   ['A small shadow will help', 'A bigger shade is needed', 'Full shade needed now!'],
      seed:  ['One little hole to fill', 'A couple of holes to fill', 'Many holes to fill!'],
      animal:['I hear a small rustle', 'I can see it coming', 'It is eating the plants!']
    };
    return { text: texts[role][level - 1], hint: '' };
  }
}

// ======================== ACTION PROCESSING ========================

function processAction(game, socketId, chosenLevel) {
  const player = game.players.get(socketId);
  if (!player || !player.problems) return null;
  if (player.problemIdx >= player.problems.length) return null;

  const prob = player.problems[player.problemIdx];
  if (prob.solved) return null;

  const diff = Math.abs(chosenLevel - prob.level);
  let result, msg, points;

  if (diff === 0) {
    result = 'perfect'; points = 15;
    msg = pick(['Perfect!', 'Spot on!', 'Just right!', 'Yes!']);
    game.health = Math.min(100, game.health + 3);
  } else if (diff === 1) {
    result = 'close'; points = 5;
    msg = pick(['Almost!', 'Close!', 'Nearly right!']);
  } else {
    result = 'wrong'; points = 0;
    msg = pick(['Not quite!', 'Try next time!', 'Oops!']);
    game.health = Math.max(0, game.health - 3);
  }

  game.score += points;
  prob.solved = true;
  prob.result = result;

  // Apply action to garden
  const plot = game.garden[prob.plotRow][prob.plotCol];
  applyActionToGarden(plot, player.role, chosenLevel, prob.level);

  player.problemIdx++;

  return { result, msg, correctLevel: prob.level, chosenLevel, points };
}

function applyActionToGarden(plot, role, chosen, correct) {
  const effectiveness = chosen === correct ? 1 : (Math.abs(chosen - correct) === 1 ? 0.6 : 0.2);
  switch (role) {
    case 'water':
      plot.moisture = Math.min(70, plot.moisture + Math.round(30 * effectiveness));
      if (plot.plant && plot.plant.stage === 'wilting' && effectiveness >= 0.6) plot.plant.stage = 'growing';
      break;
    case 'sun':
      plot.sunlight = Math.max(35, plot.sunlight - Math.round(35 * effectiveness));
      plot.shaded = effectiveness >= 0.6;
      break;
    case 'animal':
      if (effectiveness >= 0.6) plot.animal = null;
      break;
    case 'seed':
      if (effectiveness >= 0.6 && !plot.plant) {
        const pt = pick(PLANT_TYPES);
        const stages = ['seed', 'seed', 'sprout'];
        plot.plant = { type: pt.type, emoji: pt.emoji, stage: stages[chosen - 1] || 'seed' };
        plot.moisture = 50; plot.sunlight = 50;
      }
      break;
  }
}

// ======================== GAME FLOW ========================

function startRound(game) {
  game.round++;
  game.roundTimeLeft = ROUND_DURATION;
  if (game.round > 1) advancePlants(game.garden);

  // Generate problems for each player
  const usedByRole = { water: new Set(), sun: new Set(), seed: new Set(), animal: new Set() };
  for (const [sid, player] of game.players) {
    player.problems = makeProblemsForPlayer(game, player, usedByRole);
    player.problemIdx = 0;
  }

  const gardenData = serializeGarden(game.garden);

  // Notify TV
  io.to(game.tvSocketId).emit('round-start', {
    round: game.round, totalRounds: TOTAL_ROUNDS,
    garden: gardenData, health: game.health, score: game.score,
    duration: ROUND_DURATION,
    assignments: getAssignments(game)
  });

  // Send first problem to each player
  for (const [sid] of game.players) {
    sendProblemToPlayer(game, sid);
  }

  // Timer
  game.roundTimer = setInterval(() => {
    game.roundTimeLeft--;
    if (game.roundTimeLeft <= 0) endRound(game);
  }, 1000);
}

function sendProblemToPlayer(game, sid) {
  const player = game.players.get(sid);
  if (!player) return;

  if (player.problemIdx >= player.problems.length) {
    // All done for this round
    const solved = player.problems.filter(p => p.result === 'perfect').length;
    io.to(sid).emit('all-done', {
      solved, total: player.problems.length,
      score: game.score, health: game.health
    });
    return;
  }

  const prob = player.problems[player.problemIdx];
  io.to(sid).emit('problem', {
    plotLabel: prob.plotLabel,
    plotEmoji: prob.plotEmoji,
    plotRow: prob.plotRow, plotCol: prob.plotCol,
    clueText: prob.clueText,
    clueHint: prob.clueHint,
    problemNum: player.problemIdx + 1,
    totalProblems: player.problems.length,
    round: game.round, totalRounds: TOTAL_ROUNDS,
    score: game.score, health: game.health,
    buttons: ACTION_BUTTONS[player.role],
    labels: ACTION_LABELS
  });
}

function getAssignments(game) {
  const list = [];
  for (const [sid, player] of game.players) {
    if (!player.problems) continue;
    for (let i = 0; i < player.problems.length; i++) {
      const prob = player.problems[i];
      list.push({
        playerName: player.name,
        roleIcon: ROLE_INFO[player.role].icon,
        roleColor: ROLE_INFO[player.role].color,
        plotRow: prob.plotRow, plotCol: prob.plotCol,
        solved: prob.solved,
        active: i === player.problemIdx
      });
    }
  }
  return list;
}

function endRound(game) {
  if (game.roundTimer) { clearInterval(game.roundTimer); game.roundTimer = null; }

  // Penalize unsolved problems
  let totalProblems = 0, totalSolved = 0;
  for (const [, player] of game.players) {
    if (!player.problems) continue;
    for (const prob of player.problems) {
      totalProblems++;
      if (prob.solved) totalSolved++;
      else {
        game.health = Math.max(0, game.health - 4);
        // Wilt unhelped plants
        const plot = game.garden[prob.plotRow][prob.plotCol];
        if (plot.plant && prob.level >= 2) plot.plant.stage = 'wilting';
      }
    }
  }

  if (totalSolved === totalProblems && totalProblems > 0) game.score += 20;

  const result = {
    round: game.round, totalRounds: TOTAL_ROUNDS,
    solved: totalSolved, total: totalProblems,
    score: game.score, health: game.health,
    garden: serializeGarden(game.garden)
  };

  io.to(game.code).emit('round-end', result);

  if (game.round >= TOTAL_ROUNDS || game.health <= 0) {
    setTimeout(() => endGame(game), 6000);
  } else {
    setTimeout(() => { if (game.state === 'playing') startRound(game); }, 7000);
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

  io.to(game.code).emit('game-over', {
    score: game.score, health: game.health, rating,
    win: game.health > 50,
    garden: serializeGarden(game.garden),
    message: game.health > 50 ? 'Great teamwork! The garden is beautiful!' : 'The garden needs more love. Try again!'
  });
}

// ======================== SOCKET HANDLERS ========================

io.on('connection', (socket) => {

  socket.on('create-room', async () => {
    const code = generateRoomCode();
    const ip = getLocalIP();
    const joinUrl = `http://${ip}:${PORT}/phone.html?room=${code}`;
    let qrDataUrl = '';
    try { qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 280, margin: 1, color: { dark: '#2E4F1F', light: '#FFFFFF' } }); } catch (e) {}

    const game = {
      code, tvSocketId: socket.id,
      players: new Map(), state: 'lobby',
      round: 0, garden: null, health: 100, score: 0,
      roundTimer: null, roundTimeLeft: 0
    };
    rooms.set(code, game);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room-created', { code, qrDataUrl, joinUrl });
  });

  socket.on('join-room', ({ code, name }) => {
    const rc = (code || '').toUpperCase().trim();
    const game = rooms.get(rc);
    if (!game) return socket.emit('join-error', { message: 'Room not found.' });
    if (game.state !== 'lobby') return socket.emit('join-error', { message: 'Game already started.' });
    if (game.players.size >= 15) return socket.emit('join-error', { message: 'Room is full!' });

    const roleIdx = game.players.size % ROLES.length;
    const role = ROLES[roleIdx];
    const info = ROLE_INFO[role];

    const player = { id: socket.id, name: name.trim() || 'Player', role, score: 0, problems: [], problemIdx: 0 };
    game.players.set(socket.id, player);
    socket.join(rc);
    socket.roomCode = rc;

    socket.emit('joined', {
      role, roleName: info.name, roleColor: info.color,
      roleIcon: info.icon, roleDesc: info.desc, playerName: player.name,
      buttons: ACTION_BUTTONS[role], labels: ACTION_LABELS
    });

    io.to(game.tvSocketId).emit('player-joined', { players: getPlayerList(game) });
  });

  socket.on('start-game', () => {
    const game = rooms.get(socket.roomCode);
    if (!game || game.tvSocketId !== socket.id || game.state !== 'lobby') return;
    if (game.players.size < 1) return socket.emit('game-error', { message: 'Need at least 1 player.' });

    game.state = 'playing';
    game.garden = createGarden();
    io.to(game.code).emit('game-starting', { players: getPlayerList(game), totalRounds: TOTAL_ROUNDS });
    setTimeout(() => startRound(game), 3000);
  });

  // Player picks an action level (1, 2, or 3)
  socket.on('player-action', ({ level }) => {
    const game = rooms.get(socket.roomCode);
    if (!game || game.state !== 'playing') return;

    const result = processAction(game, socket.id, level);
    if (!result) return;

    const player = game.players.get(socket.id);

    // Send result to player
    socket.emit('action-result', {
      result: result.result, msg: result.msg,
      correctLevel: result.correctLevel, chosenLevel: result.chosenLevel,
      points: result.points, score: game.score, health: game.health
    });

    // Update TV
    io.to(game.tvSocketId).emit('garden-update', {
      garden: serializeGarden(game.garden),
      health: game.health, score: game.score,
      assignments: getAssignments(game),
      action: {
        playerName: player.name, roleIcon: ROLE_INFO[player.role].icon,
        result: result.result, plotRow: result.correctLevel !== undefined ? player.problems[player.problemIdx - 1].plotRow : 0,
        plotCol: result.correctLevel !== undefined ? player.problems[player.problemIdx - 1].plotCol : 0
      }
    });

    // Send next problem after a delay
    setTimeout(() => sendProblemToPlayer(game, socket.id), 2500);
  });

  socket.on('get-time', () => {
    const game = rooms.get(socket.roomCode);
    if (game) socket.emit('time-sync', { timeLeft: game.roundTimeLeft });
  });

  socket.on('disconnect', () => {
    const game = rooms.get(socket.roomCode);
    if (!game) return;
    if (socket.id === game.tvSocketId) {
      if (game.roundTimer) clearInterval(game.roundTimer);
      io.to(game.code).emit('game-error', { message: 'TV disconnected.' });
      rooms.delete(game.code);
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
  console.log('\n' + '='.repeat(50));
  console.log('  GARDEN GUARDIANS - Multiplayer Garden Game');
  console.log('='.repeat(50));
  console.log(`  TV Screen:  http://${ip}:${PORT}/tv.html`);
  console.log(`  Players:    http://${ip}:${PORT}/phone.html`);
  console.log(`  Local:      http://localhost:${PORT}`);
  console.log('='.repeat(50) + '\n');
});
