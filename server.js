const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

let games = {};
let users = {};

io.on('connection', (socket) => {
  console.log('사용자 연결:', socket.id);
  
  users[socket.id] = { id: socket.id, role: null, gameId: null };

  // 게임 생성
  socket.on('create-game', (data) => {
    const gameId = Date.now().toString();
    games[gameId] = {
      id: gameId,
      pitcher: socket.id,
      batter: null,
      mode: data.mode,
      inning: 1,
      half: 0,
      scores: [0, 0],
      balls: 0,
      strikes: 0,
      bases: [false, false, false],
      pitch: null,
      targetZone: null
    };
    users[socket.id].gameId = gameId;
    users[socket.id].role = 'pitcher';
    socket.emit('game-created', { gameId, role: 'pitcher' });
  });

  // 게임 참가
  socket.on('join-game', (data) => {
    const gameId = data.gameId;
    if (games[gameId]) {
      games[gameId].batter = socket.id;
      users[socket.id].gameId = gameId;
      users[socket.id].role = 'batter';
      
      const game = games[gameId];
      io.to(games[gameId].pitcher).emit('batter-joined', { role: 'pitcher' });
      socket.emit('game-joined', { gameId, role: 'batter', game });
      
      // 양쪽 플레이어에게 게임 상태 전송
      io.to(gameId).emit('update-game', game);
    } else {
      socket.emit('error', { message: '게임을 찾을 수 없습니다.' });
    }
  });

  // 게임 목록 요청
  socket.on('get-games', () => {
    const availableGames = Object.values(games).filter(g => !g.batter);
    socket.emit('games-list', availableGames);
  });

  // 투수 - 구종 선택
  socket.on('choose-pitch', (data) => {
    const gameId = users[socket.id].gameId;
    if (games[gameId]) {
      games[gameId].pitch = data.pitch;
      io.to(games[gameId].batter).emit('pitcher-chose', { pitch: data.pitch });
    }
  });

  // 투수 - 구역 선택 (공 던지기)
  socket.on('pitch-zone', (data) => {
    const gameId = users[socket.id].gameId;
    if (games[gameId]) {
      games[gameId].targetZone = data.zone;
      games[gameId].pitch = data.pitch;
      io.to(gameId).emit('ball-thrown', { 
        zone: data.zone, 
        pitch: data.pitch 
      });
    }
  });

  // 타자 - 스윙
  socket.on('swing', (data) => {
    const gameId = users[socket.id].gameId;
    if (games[gameId]) {
      const game = games[gameId];
      const meterValue = data.meter;
      const timing = Math.abs(75 - meterValue);
      const power = data.power;
      
      let chance = (timing < 18 ? 0.8 : timing < 35 ? 0.48 : 0.2);
      if (power) chance *= 0.82;
      
      let result;
      if (Math.random() > chance) {
        game.strikes++;
        result = { type: 'miss', message: '헛스윙! 스트라이크' };
      } else {
        result = resolveHit(game, power);
      }
      
      io.to(gameId).emit('swing-result', result);
      
      if (result.type === 'out' || game.strikes >= 3) {
        changeHalf(game);
      } else if (game.balls >= 4) {
        game.scores[game.half]++;
        game.balls = 0;
        game.strikes = 0;
        result.message = '볼넷! 1점이 추가됩니다.';
      }
      
      game.balls = result.type === 'hit' ? 0 : game.balls;
      game.strikes = result.type === 'hit' ? 0 : game.strikes;
      
      io.to(gameId).emit('update-game', game);
    }
  });

  // 타자 - 기다리기
  socket.on('take', () => {
    const gameId = users[socket.id].gameId;
    if (games[gameId]) {
      const game = games[gameId];
      const ballOutside = ![2, 4, 5, 6, 8].includes(game.targetZone) || Math.random() < 0.25;
      
      if (ballOutside) {
        game.balls++;
        io.to(gameId).emit('swing-result', { type: 'ball', message: '볼!' });
      } else {
        game.strikes++;
        io.to(gameId).emit('swing-result', { type: 'strike', message: '스트라이크!' });
      }
      
      if (game.strikes >= 3) {
        changeHalf(game);
      } else if (game.balls >= 4) {
        game.scores[game.half]++;
        game.balls = 0;
        game.strikes = 0;
        io.to(gameId).emit('swing-result', { type: 'ball', message: '볼넷! 1점이 추가됩니다.' });
      }
      
      io.to(gameId).emit('update-game', game);
    }
  });

  // 도루
  socket.on('steal', () => {
    const gameId = users[socket.id].gameId;
    if (games[gameId]) {
      const game = games[gameId];
      if (!game.bases.some(Boolean)) {
        io.to(gameId).emit('steal-result', { success: false, message: '도루할 주자가 없습니다!' });
        return;
      }
      
      if (Math.random() < 0.62) {
        if (game.bases[2]) {
          game.scores[game.half]++;
          game.bases[2] = false;
          io.to(gameId).emit('steal-result', { success: true, message: '홈 도루 성공! 1점!' });
        } else if (game.bases[1]) {
          game.bases[2] = true;
          game.bases[1] = false;
          io.to(gameId).emit('steal-result', { success: true, message: '3루 도루 성공!' });
        } else if (game.bases[0]) {
          game.bases[1] = true;
          game.bases[0] = false;
          io.to(gameId).emit('steal-result', { success: true, message: '2루 도루 성공!' });
        }
      } else {
        if (game.bases[2]) game.bases[2] = false;
        else if (game.bases[1]) game.bases[1] = false;
        else game.bases[0] = false;
        io.to(gameId).emit('steal-result', { success: false, message: '도루 실패! 주자가 아웃되었습니다.' });
      }
      
      io.to(gameId).emit('update-game', game);
    }
  });

  socket.on('disconnect', () => {
    const gameId = users[socket.id]?.gameId;
    if (gameId && games[gameId]) {
      io.to(gameId).emit('player-disconnected', { message: '상대 플레이어가 나갔습니다.' });
      delete games[gameId];
    }
    delete users[socket.id];
  });
});

function resolveHit(game, power) {
  let r = Math.random();
  let result;
  
  if (r < 0.10) result = 'homerun';
  else if (r < 0.27) result = 'double';
  else if (r < 0.63) result = 'single';
  else if (r < 0.78) result = 'foul';
  else result = 'out';
  
  if (power && result === 'single' && Math.random() < 0.45) result = 'double';
  
  if (result === 'foul') {
    game.strikes = Math.min(2, game.strikes + 1);
    return { type: 'foul', message: '파울!' };
  }
  if (result === 'out') {
    return { type: 'out', message: '아웃!' };
  }
  if (result === 'homerun') {
    let n = 1 + game.bases.filter(Boolean).length;
    game.scores[game.half] += n;
    game.bases = [false, false, false];
    return { type: 'hit', message: `💥 홈런! ${n}점!` };
  }
  if (result === 'double') {
    advance(game, 2);
    return { type: 'hit', message: '장타! 2루타!' };
  }
  advance(game, 1);
  return { type: 'hit', message: '안타!' };
}

function advance(game, n) {
  for (let i = 2; i >= 0; i--) {
    if (game.bases[i]) {
      let to = i + n;
      if (to >= 3) game.scores[game.half]++;
      else game.bases[to] = true;
      game.bases[i] = false;
    }
  }
  game.bases[n - 1] = true;
}

function changeHalf(game) {
  game.balls = 0;
  game.strikes = 0;
  game.bases = [false, false, false];
  
  if (game.half === 0) {
    game.half = 1;
  } else {
    game.half = 0;
    game.inning++;
    if (game.inning > 3) {
      const winner = game.scores[0] === game.scores[1] ? '무승부' : game.scores[0] > game.scores[1] ? '1P 승리' : '2P 승리';
      return { gameOver: true, winner };
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
