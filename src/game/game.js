import { makeDeck, shuffle, cardLabel, rankIndex, isSpeto } from './cards.js';
import { classifyMeld, canLayOff, addToMeld, findMeldCombosWithCard } from './melds.js';
import { isTingTem, couldBeUsedBy, wasPairedWithHead } from './penalties.js';
import { calculateScores, BONUS_KNOCK } from './scoring.js';

const HAND_SIZE_BY_PLAYERS = { 2: 11, 3: 9, 4: 7 };

const DEFAULT_CONFIG = {};

let meldCounter = 0;
function nextMeldId() {
  meldCounter += 1;
  return `m${meldCounter}`;
}

function nextIdx(i, len) {
  return (i + 1) % len;
}

export class DummyGame {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.players = [];
    this.stock = [];
    this.discardPile = [];
    this.melds = [];
    this.currentPlayerIndex = 0;
    this.turnPhase = 'lobby';
    this.roundNumber = 0;
    this.dealerIndex = 0;
    this.headCardId = null;
    this.headTaken = false;
    this.mustUseCardIds = new Set();
    this.lastDiscard = null; // { cardId, discarderId } — set on discard, cleared when next player draws
    this.knockerId = null;
    this.knockType = null;
    this.lastRoundScores = null;
    this.log = [];
  }

  // ---- Room management ----
  addPlayer(id, name) {
    if (this.turnPhase !== 'lobby') return { ok: false, error: 'Game already started' };
    if (this.players.length >= 4) return { ok: false, error: 'Room is full' };
    if (this.players.some((p) => p.id === id)) return { ok: false, error: 'Already in room' };
    this.players.push(this._blankPlayer(id, name));
    return { ok: true };
  }

  _blankPlayer(id, name) {
    return {
      id,
      name,
      hand: [],
      drawnCardIds: new Set(),      // cards currently in hand that were drawn (not dealt)
      hasMelded: false,             // has ever melded in this round
      hadMeldedBeforeTurn: false,   // snapshot at turn start (for blind-knock detection)
      penalties: [],                // [{type: 'tingMee'|'piHua'|'tem'|'spetoLayoff'|'stupid'}]
      knockType: null,
      totalScore: 0,
      connected: true,
    };
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, error: 'Not in room' };
    if (this.turnPhase === 'lobby') { this.players.splice(idx, 1); return { ok: true }; }
    this.players[idx].connected = false;
    return { ok: true, midGame: true };
  }

  setConnected(id, v) {
    const p = this.players.find((p) => p.id === id);
    if (p) p.connected = v;
  }

  // ---- Start / round setup ----
  startGame() {
    if (this.turnPhase !== 'lobby') return { ok: false, error: 'Already started' };
    if (this.players.length < 2) return { ok: false, error: 'Need at least 2 players' };
    if (this.players.length > 4) return { ok: false, error: 'Max 4 players' };
    this.roundNumber = 0;
    this.dealerIndex = 0;
    for (const p of this.players) p.totalScore = 0;
    return this._startNewRound();
  }

  _startNewRound() {
    this.roundNumber += 1;
    for (const p of this.players) {
      p.hand = [];
      p.drawnCardIds = new Set();
      p.hasMelded = false;
      p.hadMeldedBeforeTurn = false;
      p.penalties = [];
      p.knockType = null;
    }
    this.melds = [];
    this.mustUseCardIds = new Set();
    this.headTaken = false;
    this.lastDiscard = null;
    this.knockerId = null;
    this.knockType = null;

    const deck = shuffle(makeDeck());
    const handSize = HAND_SIZE_BY_PLAYERS[this.players.length] || 7;
    for (let i = 0; i < handSize; i++) {
      for (let p = 0; p < this.players.length; p++) {
        this.players[p].hand.push(deck.pop());
      }
    }
    const firstDiscard = deck.pop();
    this.discardPile = [firstDiscard];
    this.headCardId = firstDiscard.id;
    this.stock = deck;

    this.currentPlayerIndex = (this.dealerIndex + 1) % this.players.length;
    this.players[this.currentPlayerIndex].hadMeldedBeforeTurn = this.players[this.currentPlayerIndex].hasMelded;
    this.turnPhase = 'draw';
    this._log(`เริ่มรอบที่ ${this.roundNumber} — หัวคือ ${cardLabel(firstDiscard)}. ${this.players[this.currentPlayerIndex].name} เริ่มก่อน.`);
    return { ok: true };
  }

  // ---- Actions ----
  _requireCurrentPlayer(playerId) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) return { ok: false, error: 'Not in game' };
    if (idx !== this.currentPlayerIndex) return { ok: false, error: 'Not your turn' };
    return { ok: true, idx };
  }

  drawStock(playerId) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'draw') return { ok: false, error: 'Not draw phase' };
    if (this.stock.length === 0) return this._endRoundStockOut();
    const card = this.stock.pop();
    const p = this.players[r.idx];
    p.hand.push(card);
    p.drawnCardIds.add(card.id);
    this.turnPhase = 'meld';
    this._log(`${p.name} จั่วจากกอง.`);
    // Player drew from stock, not from discard, so the previous player's ทิ้งมี่ risk resolves as "not taken"
    this.lastDiscard = null;
    return { ok: true };
  }

  drawDiscard(playerId) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'draw') return { ok: false, error: 'Not draw phase' };
    if (this.discardPile.length === 0) return { ok: false, error: 'ไม่มีไพ่ในกองทิ้ง' };
    const card = this.discardPile.pop();
    const p = this.players[r.idx];
    p.hand.push(card);
    p.drawnCardIds.add(card.id);
    this.mustUseCardIds.add(card.id);
    this.turnPhase = 'meld';
    this._log(`${p.name} เก็บ ${cardLabel(card)} จากกองทิ้ง.`);
    // Don't clear lastDiscard yet — it will be evaluated when we see how they use this card
    return { ok: true, drewCardId: card.id };
  }

  meld(playerId, cardIds) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'meld') return { ok: false, error: 'ยังไม่ถึงช่วงเกิด' };
    const p = this.players[r.idx];
    const cards = cardIds.map((id) => p.hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) return { ok: false, error: 'ไม่มีไพ่ในมือ' };
    const type = classifyMeld(cards);
    if (!type) return { ok: false, error: 'ไม่ใช่ตอง/เรียงที่ถูกต้อง' };
    // Rule 6.1: meld must include at least 1 card drawn from stock/discard
    if (!cards.some((c) => p.drawnCardIds.has(c.id))) {
      return { ok: false, error: 'ต้องมีไพ่ที่จั่วมาอย่างน้อย 1 ใบในชุด' };
    }
    // Apply
    p.hand = p.hand.filter((c) => !cardIds.includes(c.id));
    for (const id of cardIds) { p.drawnCardIds.delete(id); this.mustUseCardIds.delete(id); }

    const contributions = {};
    for (const c of cards) contributions[c.id] = p.id;
    const orderedCards = type === 'run' ? [...cards].sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank)) : cards;
    const meld = { id: nextMeldId(), type, cards: orderedCards, contributions };
    this.melds.push(meld);

    // Head taken check
    if (!this.headTaken && cardIds.includes(this.headCardId)) this.headTaken = true;
    // First-ever meld this round
    p.hasMelded = true;
    // If this uses the previous discarder's card → ทิ้งมี่ penalty (unless a knock follows)
    this._maybePenalizePriorDiscarder(cardIds);

    this._log(`${p.name} เกิด ${type}: ${cards.map(cardLabel).join(' ')}.`);
    return { ok: true, meldId: meld.id };
  }

  layOff(playerId, cardId, meldId) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'meld') return { ok: false, error: 'ยังไม่ถึงช่วงฝาก' };
    const p = this.players[r.idx];
    if (!p.hasMelded) return { ok: false, error: 'ต้องเคยเกิดแล้วก่อนถึงจะฝากได้' };
    const card = p.hand.find((c) => c.id === cardId);
    if (!card) return { ok: false, error: 'ไม่มีไพ่ในมือ' };
    const meldIdx = this.melds.findIndex((m) => m.id === meldId);
    if (meldIdx === -1) return { ok: false, error: 'ไม่พบกอง' };
    const meld = this.melds[meldIdx];
    if (!canLayOff(card, meld)) return { ok: false, error: 'ฝากใบนี้ไม่ได้' };
    // Apply
    p.hand = p.hand.filter((c) => c.id !== cardId);
    p.drawnCardIds.delete(cardId);
    this.mustUseCardIds.delete(cardId);
    const updated = addToMeld(meld, card);
    updated.contributions = { ...meld.contributions, [card.id]: p.id };
    this.melds[meldIdx] = updated;
    if (!this.headTaken && card.id === this.headCardId) this.headTaken = true;

    // ถูกฝากสเปโต: if the layoff card is a speto AND the meld had a different owner
    if (isSpeto(card)) {
      const originalOwners = new Set(
        Object.entries(meld.contributions).map(([, ownerId]) => ownerId)
      );
      for (const owner of originalOwners) {
        if (owner !== p.id) {
          const victim = this.players.find((pl) => pl.id === owner);
          if (victim) victim.penalties.push({ type: 'spetoLayoff' });
        }
      }
      this._log(`${p.name} ฝากสเปโต ${cardLabel(card)}!`);
    } else {
      this._log(`${p.name} ฝาก ${cardLabel(card)}.`);
    }

    // ทิ้งมี่ check
    this._maybePenalizePriorDiscarder([cardId]);
    return { ok: true };
  }

  discard(playerId, cardId) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'meld') return { ok: false, error: 'ยังไม่ถึงช่วงทิ้ง' };
    const p = this.players[r.idx];
    const card = p.hand.find((c) => c.id === cardId);
    if (!card) return { ok: false, error: 'ไม่มีไพ่ในมือ' };
    if (this.mustUseCardIds.size > 0) {
      return { ok: false, error: 'ต้องใช้ไพ่ที่เก็บมาก่อนทิ้ง' };
    }

    p.hand = p.hand.filter((c) => c.id !== cardId);
    p.drawnCardIds.delete(cardId);

    // ทิ้งเต็ม: 2+ cards already in discard pile combine with this card to form a valid meld
    const pileBeforeThis = [...this.discardPile];
    this.discardPile.push(card);
    if (isTingTem(card, pileBeforeThis)) {
      p.penalties.push({ type: 'tem' });
      this._log(`${p.name} ทิ้งเต็ม (-50).`);
    }

    // Knock detection: hand empty → knock this player, end round
    if (p.hand.length === 0) {
      p.knockType = this._classifyKnock(p);
      this.knockerId = p.id;
      this.knockType = p.knockType;
      // Whoever gave the last discard we picked up got ทิ้งโง่ (upgrade from ทิ้งมี่)
      if (this.lastDiscard && this.lastDiscard.discarderId !== p.id) {
        const feeder = this.players.find((pl) => pl.id === this.lastDiscard.discarderId);
        if (feeder) {
          // Remove any pending ทิ้งมี่ for this last-discard event and replace with ทิ้งโง่
          feeder.penalties.push({ type: 'stupid' });
          this._log(`${feeder.name} โดน "ทิ้งโง่" (-50) เพราะถูกน็อกด้วยไพ่ที่ทิ้ง.`);
        }
      }
      this._log(`${p.name} น็อก${knockTypeLabel(p.knockType)}! (+${BONUS_KNOCK})`);
      return this._endRound();
    }

    // Record this discard as the potential "feed" for the next player
    this.lastDiscard = { cardId: card.id, discarderId: p.id };
    this._log(`${p.name} ทิ้ง ${cardLabel(card)}.`);

    // Advance turn
    this._advanceTurn();
    // Stock-out end condition: if next player draws from empty stock and can't/doesn't take discard,
    // handled inside drawStock.
    return { ok: true };
  }

  // ---- Internal ----
  _maybePenalizePriorDiscarder(usedCardIds) {
    if (!this.lastDiscard) return;
    // Only if the used card set includes the last-discard card (i.e., the player used it in a meld/layoff)
    if (!usedCardIds.includes(this.lastDiscard.cardId)) return;
    const discarder = this.players.find((p) => p.id === this.lastDiscard.discarderId);
    const currentPlayer = this.players[this.currentPlayerIndex];
    if (!discarder || discarder.id === currentPlayer.id) { this.lastDiscard = null; return; }
    // Avoid double-penalizing across multiple uses of the same picked-up card
    const already = discarder.penalties.some((x) => x._fromDiscardId === this.lastDiscard.cardId);
    if (already) return;
    // Check ทิ้งปี้หัว: the used card was paired with head in a meld this player just formed
    const paired = wasPairedWithHead(
      { id: this.lastDiscard.cardId },
      this.melds,
      this.headCardId
    );
    if (paired && this.lastDiscard.cardId !== this.headCardId) {
      discarder.penalties.push({ type: 'piHua', _fromDiscardId: this.lastDiscard.cardId });
      this._log(`${discarder.name} โดน "ทิ้งปี้หัว" (-50).`);
    } else {
      discarder.penalties.push({ type: 'tingMee', _fromDiscardId: this.lastDiscard.cardId });
      this._log(`${discarder.name} โดน "ทิ้งมี่" (-50).`);
    }
    // Keep lastDiscard until turn ends (in case knock happens → upgrade to ทิ้งโง่)
  }

  _classifyKnock(player) {
    const blind = !player.hadMeldedBeforeTurn; // never melded before this turn
    // Color: all their contributed cards across all melds are one suit (excluding the just-discarded card)
    const suits = new Set();
    for (const m of this.melds) {
      for (const c of m.cards) {
        if (m.contributions?.[c.id] === player.id) suits.add(c.suit);
      }
    }
    const color = suits.size === 1;
    if (blind && color) return 'blindColor';
    if (blind) return 'blind';
    if (color) return 'color';
    return 'normal';
  }

  _advanceTurn() {
    this.currentPlayerIndex = nextIdx(this.currentPlayerIndex, this.players.length);
    let safety = this.players.length;
    while (!this.players[this.currentPlayerIndex].connected && safety-- > 0) {
      this.currentPlayerIndex = nextIdx(this.currentPlayerIndex, this.players.length);
    }
    // Snapshot melded-before-turn for the new current player (used for blind-knock)
    const cur = this.players[this.currentPlayerIndex];
    cur.hadMeldedBeforeTurn = cur.hasMelded;
    this.turnPhase = 'draw';
  }

  _endRoundStockOut() {
    // Stock ran out with no knock → each player scores what they've melded so far; no knock bonus.
    this._log('ไพ่กองจั่วหมด — จบเกม (ไม่มีการน็อก).');
    return this._endRound();
  }

  _endRound() {
    const scores = calculateScores({
      players: this.players,
      melds: this.melds,
      headCardId: this.headCardId,
      knockerId: this.knockerId,
    });
    for (const s of scores) {
      const p = this.players.find((pl) => pl.id === s.playerId);
      p.totalScore += s.net;
    }
    this.lastRoundScores = scores;
    this.turnPhase = 'roundEnd';
    return { ok: true, roundEnded: true, scores };
  }

  nextRound() {
    if (this.turnPhase !== 'roundEnd') return { ok: false, error: 'Not at round end' };
    this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
    return this._startNewRound();
  }

  _log(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 200) this.log.shift();
  }

  // ---- Snapshot ----
  snapshotForPlayer(viewerId) {
    return {
      roundNumber: this.roundNumber,
      turnPhase: this.turnPhase,
      currentPlayerId: this.players[this.currentPlayerIndex]?.id,
      stockCount: this.stock.length,
      discardPile: this.discardPile.map(publicCard),
      discardTop: this.discardPile.length ? publicCard(this.discardPile[this.discardPile.length - 1]) : null,
      headCardId: this.headCardId,
      headTaken: this.headTaken,
      melds: this.melds.map((m) => ({
        id: m.id,
        type: m.type,
        cards: m.cards.map(publicCard),
        contributions: m.contributions || {},
      })),
      mustUseCardIds: [...this.mustUseCardIds],
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        hasMelded: p.hasMelded,
        totalScore: p.totalScore,
        penalties: p.penalties.map((x) => ({ type: x.type })),
        knockType: p.knockType,
        connected: p.connected,
        isCurrent: this.players[this.currentPlayerIndex]?.id === p.id,
        hand: p.id === viewerId ? p.hand.map((c) => ({
          ...publicCard(c),
          drawn: p.drawnCardIds.has(c.id),
        })) : undefined,
      })),
      lastRoundScores: this.lastRoundScores,
      log: this.log.slice(-40),
      config: {},
    };
  }
}

function publicCard(c) {
  return { id: c.id, suit: c.suit, rank: c.rank, points: c.points, isSpeto: !!c.isSpeto };
}

function knockTypeLabel(t) {
  return t === 'blindColor' ? 'มืดสี' : t === 'color' ? 'สี' : t === 'blind' ? 'มืด' : '';
}
