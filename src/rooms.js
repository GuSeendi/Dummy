import { DummyGame } from './game/game.js';

// Simple in-memory room store
export class RoomStore {
  constructor() {
    this.rooms = new Map(); // roomCode -> Room
  }

  create(hostSocketId, hostName, config = {}) {
    const code = generateCode();
    const game = new DummyGame(config);
    game.addPlayer(hostSocketId, hostName);
    const room = { code, hostId: hostSocketId, game, spetoTimer: null };
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(code);
  }

  findByPlayerId(playerId) {
    for (const room of this.rooms.values()) {
      if (room.game.players.some((p) => p.id === playerId)) return room;
    }
    return null;
  }

  delete(code) {
    const room = this.rooms.get(code);
    if (room?.spetoTimer) clearTimeout(room.spetoTimer);
    this.rooms.delete(code);
  }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
