import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { RoomStore } from './src/rooms.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const rooms = new RoomStore();

function broadcastRoom(room) {
  for (const p of room.game.players) {
    io.to(p.id).emit('state', {
      roomCode: room.code,
      hostId: room.hostId,
      state: room.game.snapshotForPlayer(p.id),
    });
  }
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name, config }, ack) => {
    const displayName = (name || 'Player').slice(0, 20);
    const room = rooms.create(socket.id, displayName, config || {});
    socket.join(room.code);
    ack?.({ ok: true, roomCode: room.code });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name }, ack) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    const displayName = (name || 'Player').slice(0, 20);
    const r = room.game.addPlayer(socket.id, displayName);
    if (!r.ok) return ack?.(r);
    socket.join(room.code);
    ack?.({ ok: true, roomCode: room.code });
    broadcastRoom(room);
  });

  socket.on('startGame', (_, ack) => {
    const room = rooms.findByPlayerId(socket.id);
    if (!room) return ack?.({ ok: false, error: 'Not in a room' });
    if (room.hostId !== socket.id) return ack?.({ ok: false, error: 'Only host can start' });
    const r = room.game.startGame();
    ack?.(r);
    if (r.ok) broadcastRoom(room);
  });

  const gameAction = (fn) => (payload, ack) => {
    const room = rooms.findByPlayerId(socket.id);
    if (!room) return ack?.({ ok: false, error: 'Not in a room' });
    const res = fn(room, payload);
    ack?.(res);
    if (res.ok) broadcastRoom(room);
  };

  socket.on('drawStock', gameAction((room) => room.game.drawStock(socket.id)));
  socket.on('drawDiscard', gameAction((room) => room.game.drawDiscard(socket.id)));
  socket.on('meld', gameAction((room, { cardIds }) => room.game.meld(socket.id, cardIds || [])));
  socket.on('layOff', gameAction((room, { cardId, meldId }) => room.game.layOff(socket.id, cardId, meldId)));
  socket.on('discard', gameAction((room, { cardId }) => room.game.discard(socket.id, cardId)));
  socket.on('nextRound', gameAction((room) => room.game.nextRound()));

  socket.on('leaveRoom', () => {
    const room = rooms.findByPlayerId(socket.id);
    if (!room) return;
    room.game.removePlayer(socket.id);
    socket.leave(room.code);
    if (room.game.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    // Reassign host if needed
    if (room.hostId === socket.id) room.hostId = room.game.players[0]?.id;
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.findByPlayerId(socket.id);
    if (!room) return;
    const r = room.game.removePlayer(socket.id);
    if (!r.midGame && room.game.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.game.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === socket.id) {
      const stillHere = room.game.players.find((p) => p.connected);
      if (stillHere) room.hostId = stillHere.id;
    }
    broadcastRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dummy Online listening on http://localhost:${PORT}`);
});
