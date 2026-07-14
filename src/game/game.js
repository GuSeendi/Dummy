import { makeDeck, shuffle, sumPoints } from './cards.js';
import { classifyMeld, isValidMeld, canLayOff, addToMeld, findMeldCombosWithCard } from './melds.js';
import { isStupidDiscard } from './stupid.js';
import {
  calculateRoundScores,
  BONUS_SPETO,
  BONUS_HEAD,
  BONUS_KNOCK,
  BONUS_FACE_DOWN_LAYOFF,
} from './scoring.js';

const HAND_SIZE_BY_PLAYERS = { 2: 11, 3: 9, 4: 7 };

const DEFAULT_CONFIG = {
  aceWrapsAroundKing: false,
  drawDiscardMustUseImmediately: true,
  spetoAllowedOutOfTurn: true,
  spetoWindowMs: 6000,
  headDefinition: 'firstDiscard',
  targetScore: 300, // game ends when someone reaches this
};

let meldCounter = 0;
function nextMeldId() {
  meldCounter += 1;
  return `m${meldCounter}`;
}

function nextPlayerIdx(idx, len) {
  return (idx + 1) % len;
}

export class DummyGame {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.players = []; // {id, name, hand:[], totalScore, roundBonuses:[], penalties:0, connected:true}
    this.stock = [];
    this.discardPile = []; // last element = top
    this.melds = [];
    this.currentPlayerIndex = 0;
    this.turnPhase = 'lobby'; // 'lobby'|'draw'|'meld'|'discard'|'spetoWindow'|'roundEnd'|'gameEnd'
    this.roundNumber = 0;
    this.dealerIndex = 0;
    this.headCardId = null;
    this.headCardTaken = false;
    this.mustUseCardIds = new Set(); // cards drawn from discard/head that must be melded/laidoff before discard
    this.spetoWindow = null; // {cardId, eligiblePlayerIds:[], deadline, discarderIndex}
    this.lastRoundScores = null;
    this.log = []; // event log
  }

  addPlayer(id, name) {
    if (this.turnPhase !== 'lobby') return { ok: false, error: 'Game already started' };
    if (this.players.length >= 4) return { ok: false, error: 'Room is full' };
    if (this.players.some((p) => p.id === id)) return { ok: false, error: 'Player already in room' };
    this.players.push({
      id,
      name,
      hand: [],
      totalScore: 0,
      roundBonuses: [],
      penalties: 0,
      connected: true,
    });
    return { ok: true };
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return { ok: false, error: 'Not in room' };
    if (this.turnPhase === 'lobby') {
      this.players.splice(idx, 1);
      return { ok: true };
    }
    // mid-game: mark disconnected but keep spot
    this.players[idx].connected = false;
    return { ok: true, midGame: true };
  }

  setConnected(id, connected) {
    const p = this.players.find((p) => p.id === id);
    if (p) p.connected = connected;
  }

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
      p.roundBonuses = [];
      p.penalties = 0;
    }
    this.melds = [];
    this.mustUseCardIds = new Set();
    this.headCardTaken = false;
    this.spetoWindow = null;

    const deck = shuffle(makeDeck());
    const handSize = HAND_SIZE_BY_PLAYERS[this.players.length];
    // Deal
    for (let i = 0; i < handSize; i++) {
      for (let p = 0; p < this.players.length; p++) {
        this.players[p].hand.push(deck.pop());
      }
    }
    const firstDiscard = deck.pop();
    this.discardPile = [firstDiscard];
    this.headCardId = firstDiscard.id;
    this.stock = deck;

    // First player to act is the player left of dealer
    this.currentPlayerIndex = (this.dealerIndex + 1) % this.players.length;
    this.turnPhase = 'draw';
    this._log(`Round ${this.roundNumber} started. ${this.players[this.currentPlayerIndex].name} to act.`);
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
    if (this.stock.length === 0) {
      // Reshuffle discard (except top) into stock
      if (this.discardPile.length <= 1) return { ok: false, error: 'No cards left' };
      const top = this.discardPile.pop();
      this.stock = shuffle(this.discardPile);
      this.discardPile = [top];
      // Head is buried once reshuffled
      this.headCardTaken = true;
      this._log('Reshuffled discard into stock.');
    }
    const card = this.stock.pop();
    this.players[r.idx].hand.push(card);
    this.turnPhase = 'meld';
    this._log(`${this.players[r.idx].name} drew from stock.`);
    return { ok: true };
  }

  drawDiscard(playerId) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'draw') return { ok: false, error: 'Not draw phase' };
    if (this.discardPile.length === 0) return { ok: false, error: 'Discard pile empty' };
    const card = this.discardPile.pop();
    this.players[r.idx].hand.push(card);
    this.mustUseCardIds.add(card.id);
    this.turnPhase = 'meld';
    this._log(`${this.players[r.idx].name} picked up ${cardLabel(card)} from discard.`);
    // If this is the head card, mark pending head bonus (awarded when used successfully in meld/layoff)
    return { ok: true, drewCardId: card.id, isHead: card.id === this.headCardId && !this.headCardTaken };
  }

  drawHead(playerId) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'draw') return { ok: false, error: 'Not draw phase' };
    if (this.headCardTaken) return { ok: false, error: 'Head already taken/buried' };
    const idx = this.discardPile.findIndex((c) => c.id === this.headCardId);
    if (idx === -1) return { ok: false, error: 'Head not in discard pile' };
    const [card] = this.discardPile.splice(idx, 1);
    this.players[r.idx].hand.push(card);
    this.mustUseCardIds.add(card.id);
    this.turnPhase = 'meld';
    this._log(`${this.players[r.idx].name} pulled the HEAD card ${cardLabel(card)}.`);
    return { ok: true, drewCardId: card.id, isHead: true };
  }

  meld(playerId, cardIds) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'meld') return { ok: false, error: 'Not meld phase' };
    const player = this.players[r.idx];
    const cards = cardIds.map((id) => player.hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) return { ok: false, error: 'Card not in hand' };
    const type = classifyMeld(cards, this.config);
    if (!type) return { ok: false, error: 'Not a valid set/run' };
    // Remove from hand
    player.hand = player.hand.filter((c) => !cardIds.includes(c.id));
    const meld = {
      id: nextMeldId(),
      type,
      cards: type === 'run' ? [...cards].sort((a, b) => rankIndexOf(a.rank) - rankIndexOf(b.rank)) : cards,
      ownerId: player.id,
      faceDownLayoffs: [],
    };
    this.melds.push(meld);
    // Clear must-use for these cards
    for (const id of cardIds) this.mustUseCardIds.delete(id);
    // Award head bonus if head was used in this meld
    this._maybeAwardHeadBonus(player, cardIds);
    this._log(`${player.name} melded ${type}: ${cards.map(cardLabel).join(' ')}.`);
    return { ok: true, meldId: meld.id };
  }

  layOff(playerId, cardId, meldId) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'meld') return { ok: false, error: 'Not meld phase' };
    const player = this.players[r.idx];
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) return { ok: false, error: 'Card not in hand' };
    const meldIdx = this.melds.findIndex((m) => m.id === meldId);
    if (meldIdx === -1) return { ok: false, error: 'Meld not found' };
    const meld = this.melds[meldIdx];
    if (!canLayOff(card, meld, this.config)) return { ok: false, error: 'Cannot lay off this card here' };
    player.hand = player.hand.filter((c) => c.id !== cardId);
    this.melds[meldIdx] = addToMeld(meld, card);
    this.mustUseCardIds.delete(cardId);
    this._maybeAwardHeadBonus(player, [cardId]);
    this._log(`${player.name} laid off ${cardLabel(card)} on meld ${meldId}.`);
    return { ok: true };
  }

  discard(playerId, cardId) {
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'meld' && this.turnPhase !== 'discard') return { ok: false, error: 'Not discard phase' };
    const player = this.players[r.idx];
    const card = player.hand.find((c) => c.id === cardId);
    if (!card) return { ok: false, error: 'Card not in hand' };
    if (this.mustUseCardIds.size > 0) {
      return { ok: false, error: 'You must use the picked-up card in a meld/layoff first' };
    }
    // Remove from hand, push to discard
    player.hand = player.hand.filter((c) => c.id !== cardId);
    this.discardPile.push(card);
    this._log(`${player.name} discarded ${cardLabel(card)}.`);

    // Head is buried once someone discards on top
    if (this.discardPile.length > 1 && !this.headCardTaken) {
      // Head still in pile but buried; can still be pulled via drawHead unless we choose to lock. Spec says head-take remains legal until taken or reshuffled.
    }

    // Check stupid
    const stupidResult = isStupidDiscard(card, this);
    let becameStupid = false;
    if (stupidResult.stupid) {
      player.penalties += 1;
      becameStupid = true;
      this._log(`${player.name}'s discard is stupid (${stupidResult.reason}).`);
    }

    // Check knock (hand empty)
    if (player.hand.length === 0) {
      player.roundBonuses.push({ type: 'knock', points: BONUS_KNOCK });
      this._log(`${player.name} KNOCKED! +${BONUS_KNOCK}`);
      return this._endRound({ knockerId: player.id });
    }

    // Open speto window if eligible players exist
    const eligible = this._findSpetoEligiblePlayers(card, player.id);
    if (this.config.spetoAllowedOutOfTurn && eligible.length > 0) {
      this.spetoWindow = {
        cardId: card.id,
        eligiblePlayerIds: eligible,
        discarderIndex: r.idx,
        deadline: Date.now() + this.config.spetoWindowMs,
      };
      this.turnPhase = 'spetoWindow';
      return { ok: true, spetoWindow: { cardId: card.id, eligible, deadlineMs: this.config.spetoWindowMs } };
    }

    // Otherwise advance turn
    this._advanceTurn();
    return { ok: true, becameStupid };
  }

  // Speto = out-of-turn: another player takes the just-discarded top card and forms a new meld using 2 cards from their hand.
  speto(playerId, comboCardIds) {
    if (this.turnPhase !== 'spetoWindow' || !this.spetoWindow) return { ok: false, error: 'No speto window open' };
    if (!this.spetoWindow.eligiblePlayerIds.includes(playerId)) return { ok: false, error: 'Not eligible to speto' };
    if (Date.now() > this.spetoWindow.deadline) return { ok: false, error: 'Speto window expired' };
    const spetoerIdx = this.players.findIndex((p) => p.id === playerId);
    if (spetoerIdx === -1) return { ok: false, error: 'Player not found' };
    const spetoer = this.players[spetoerIdx];
    if (!Array.isArray(comboCardIds) || comboCardIds.length !== 2) return { ok: false, error: 'Provide exactly 2 cards from hand' };
    const comboCards = comboCardIds.map((id) => spetoer.hand.find((c) => c.id === id));
    if (comboCards.some((c) => !c)) return { ok: false, error: 'Combo card not in hand' };
    const discardTop = this.discardPile[this.discardPile.length - 1];
    if (!discardTop || discardTop.id !== this.spetoWindow.cardId) return { ok: false, error: 'Discard card mismatch' };
    const trio = [discardTop, ...comboCards];
    const type = classifyMeld(trio, this.config);
    if (!type) return { ok: false, error: 'Cards do not form a valid meld with the discarded card' };
    // Apply speto
    this.discardPile.pop(); // take the card
    spetoer.hand = spetoer.hand.filter((c) => !comboCardIds.includes(c.id));
    const meld = {
      id: nextMeldId(),
      type,
      cards: type === 'run' ? [...trio].sort((a, b) => rankIndexOf(a.rank) - rankIndexOf(b.rank)) : trio,
      ownerId: spetoer.id,
      faceDownLayoffs: [],
    };
    this.melds.push(meld);
    spetoer.roundBonuses.push({ type: 'speto', points: BONUS_SPETO });
    // Discarder becomes stupid (add penalty if not already added via auto-stupid check)
    const discarder = this.players[this.spetoWindow.discarderIndex];
    // If not already flagged stupid this discard, add penalty.
    // We'll simply add another penalty because the speto rule explicitly says -50.
    // To avoid double-counting, we check: if the discard just before was flagged stupid, we still add speto penalty per spec? Spec treats them separately but both -50.
    // For fairness we add one penalty total per discard event; if auto-stupid already applied, don't double.
    // Track via a flag on spetoWindow.
    if (!this.spetoWindow._penaltyAlreadyApplied) {
      // Not tracked directly; conservative: skip additional penalty if isStupidDiscard was already stupid.
      const wasAutoStupid = isStupidDiscard(discardTop, {
        config: this.config,
        melds: this.melds.filter((m) => m.id !== meld.id), // exclude the newly-created speto meld
        discardPile: [...this.discardPile, discardTop],
      }).stupid;
      if (!wasAutoStupid) discarder.penalties += 1;
    }
    // Speto also awards head bonus if the discarded card was the head and not yet taken
    if (discardTop.id === this.headCardId && !this.headCardTaken) {
      spetoer.roundBonuses.push({ type: 'head', points: BONUS_HEAD });
      this.headCardTaken = true;
      this._log(`${spetoer.name} also took the HEAD via speto! +${BONUS_HEAD}`);
    }
    this._log(`${spetoer.name} SPETO'd ${cardLabel(discardTop)}! +${BONUS_SPETO}. ${discarder.name} is stupid.`);
    // Turn passes to spetoer, phase = meld (they can continue melding/layoffs, must discard to end)
    this.spetoWindow = null;
    this.currentPlayerIndex = spetoerIdx;
    this.turnPhase = 'meld';
    return { ok: true };
  }

  // Called by server when speto window timer expires
  resolveSpetoTimeout() {
    if (this.turnPhase !== 'spetoWindow' || !this.spetoWindow) return { ok: false };
    this._log('Speto window closed with no takers.');
    this.spetoWindow = null;
    this._advanceTurn();
    return { ok: true };
  }

  // Knock plan action: batch face-down layoffs + regular ops during meld phase, then discard.
  knockPlan(playerId, plan) {
    // plan = { melds: [ [cardId,...], ... ], layoffs: [{cardId,meldId}], faceDownLayoffs: [{cardId,meldId}], discardCardId }
    const r = this._requireCurrentPlayer(playerId);
    if (!r.ok) return r;
    if (this.turnPhase !== 'meld') return { ok: false, error: 'Not meld phase' };
    const player = this.players[r.idx];

    // Simulate against a copy of player's hand
    const handIds = new Set(player.hand.map((c) => c.id));
    const usedIds = new Set();

    // Validate melds
    const meldsToCreate = [];
    for (const cardIds of plan.melds || []) {
      for (const id of cardIds) {
        if (!handIds.has(id) || usedIds.has(id)) return { ok: false, error: 'Card unavailable for meld' };
      }
      const cards = cardIds.map((id) => player.hand.find((c) => c.id === id));
      const type = classifyMeld(cards, this.config);
      if (!type) return { ok: false, error: 'Invalid meld in plan' };
      for (const id of cardIds) usedIds.add(id);
      meldsToCreate.push({ type, cards, cardIds });
    }

    // Validate layoffs (against existing melds + newly-created melds within this plan)
    const layoffOps = [];
    for (const lo of plan.layoffs || []) {
      if (!handIds.has(lo.cardId) || usedIds.has(lo.cardId)) return { ok: false, error: 'Card unavailable for layoff' };
      const existingMeld = this.melds.find((m) => m.id === lo.meldId);
      if (!existingMeld) return { ok: false, error: 'Layoff meld not found' };
      const card = player.hand.find((c) => c.id === lo.cardId);
      if (!canLayOff(card, existingMeld, this.config)) return { ok: false, error: 'Cannot lay off this card here' };
      usedIds.add(lo.cardId);
      layoffOps.push({ card, meldId: existingMeld.id });
    }

    // Validate face-down layoffs (target any existing meld or a new-in-plan meld)
    const faceDownOps = [];
    const validMeldIds = new Set([...this.melds.map((m) => m.id)]);
    for (const fd of plan.faceDownLayoffs || []) {
      if (!handIds.has(fd.cardId) || usedIds.has(fd.cardId)) return { ok: false, error: 'Card unavailable for face-down layoff' };
      // Face-down layoff must target an EXISTING meld on table (per spec: fake layoff for cards that don't fit).
      if (!validMeldIds.has(fd.meldId)) return { ok: false, error: 'Face-down layoff must target an existing meld' };
      usedIds.add(fd.cardId);
      faceDownOps.push({ cardId: fd.cardId, meldId: fd.meldId });
    }

    // Discard
    const discardCardId = plan.discardCardId;
    if (!discardCardId || !handIds.has(discardCardId) || usedIds.has(discardCardId)) {
      return { ok: false, error: 'Invalid discard card in plan' };
    }
    usedIds.add(discardCardId);

    // Must-use cards from earlier discard-picks must all be accounted for
    for (const id of this.mustUseCardIds) {
      if (!usedIds.has(id) || id === discardCardId) {
        // Face-down layoff counts as "using" only if it goes into a meld — face-down is on an existing meld, so it counts.
        // But must-use requires being placed into a real meld/layoff, not face-down. Enforce:
        const inFaceDown = faceDownOps.some((f) => f.cardId === id);
        if (inFaceDown) return { ok: false, error: 'Picked-up card must go into a real meld/layoff, not face-down' };
        if (id === discardCardId) return { ok: false, error: 'Cannot discard the card you must use' };
        return { ok: false, error: 'A picked-up card was not used in a meld/layoff' };
      }
    }

    // Every remaining hand card must be in usedIds → hand becomes empty after discard
    for (const c of player.hand) {
      if (!usedIds.has(c.id)) return { ok: false, error: `Card ${c.rank}${suitSymbol(c.suit)} not accounted for` };
    }

    // ---- Apply plan atomically ----
    // Create melds
    for (const m of meldsToCreate) {
      const meld = {
        id: nextMeldId(),
        type: m.type,
        cards: m.type === 'run' ? [...m.cards].sort((a, b) => rankIndexOf(a.rank) - rankIndexOf(b.rank)) : m.cards,
        ownerId: player.id,
        faceDownLayoffs: [],
      };
      this.melds.push(meld);
    }
    // Apply layoffs
    for (const lo of layoffOps) {
      const idx = this.melds.findIndex((m) => m.id === lo.meldId);
      this.melds[idx] = addToMeld(this.melds[idx], lo.card);
    }
    // Apply face-down layoffs
    for (const fd of faceDownOps) {
      const idx = this.melds.findIndex((m) => m.id === fd.meldId);
      const card = player.hand.find((c) => c.id === fd.cardId);
      this.melds[idx].faceDownLayoffs.push(card);
      player.roundBonuses.push({ type: 'faceDownLayoff', points: BONUS_FACE_DOWN_LAYOFF });
    }
    // Remove all used cards from hand except discardCard (still to discard)
    const discardCard = player.hand.find((c) => c.id === discardCardId);
    const idsPlacedInMelds = new Set([
      ...meldsToCreate.flatMap((m) => m.cardIds),
      ...layoffOps.map((l) => l.card.id),
      ...faceDownOps.map((f) => f.cardId),
    ]);
    player.hand = player.hand.filter((c) => !idsPlacedInMelds.has(c.id) && c.id !== discardCardId);
    // Discard the last card
    this.discardPile.push(discardCard);
    this._log(`${player.name} played knock plan. Melds:${meldsToCreate.length} LayOffs:${layoffOps.length} FaceDown:${faceDownOps.length} Discard:${cardLabel(discardCard)}.`);

    // Award head bonus if head was in any of the used-for-meld/layoff (not face-down)
    const bonusIds = new Set([...meldsToCreate.flatMap((m) => m.cardIds), ...layoffOps.map((l) => l.card.id)]);
    this._maybeAwardHeadBonus(player, [...bonusIds]);

    // Knock bonus
    player.roundBonuses.push({ type: 'knock', points: BONUS_KNOCK });
    this._log(`${player.name} KNOCKED! +${BONUS_KNOCK}`);

    // Clear must-use
    this.mustUseCardIds.clear();

    // End round
    return this._endRound({ knockerId: player.id });
  }

  // ---- Internal helpers ----
  _maybeAwardHeadBonus(player, cardIds) {
    if (this.headCardTaken) return;
    if (!this.headCardId) return;
    if (cardIds.includes(this.headCardId)) {
      player.roundBonuses.push({ type: 'head', points: BONUS_HEAD });
      this.headCardTaken = true;
      this._log(`${player.name} used the HEAD card! +${BONUS_HEAD}`);
    }
  }

  _findSpetoEligiblePlayers(card, discarderId) {
    const eligible = [];
    for (const p of this.players) {
      if (p.id === discarderId) continue;
      if (!p.connected) continue;
      const combos = findMeldCombosWithCard(card, p.hand, this.config);
      if (combos.length > 0) eligible.push(p.id);
    }
    return eligible;
  }

  _advanceTurn() {
    this.currentPlayerIndex = nextPlayerIdx(this.currentPlayerIndex, this.players.length);
    // Skip disconnected players (but don't infinite-loop)
    let safety = this.players.length;
    while (!this.players[this.currentPlayerIndex].connected && safety-- > 0) {
      this.currentPlayerIndex = nextPlayerIdx(this.currentPlayerIndex, this.players.length);
    }
    this.turnPhase = 'draw';
  }

  _endRound({ knockerId }) {
    const scores = calculateRoundScores(this);
    for (const s of scores) {
      const p = this.players.find((pl) => pl.id === s.playerId);
      p.totalScore += s.net;
    }
    this.lastRoundScores = scores;
    this.turnPhase = 'roundEnd';
    this._log(`Round ${this.roundNumber} ended. Knocker: ${this.players.find((p) => p.id === knockerId).name}`);
    // Check game-end
    const target = this.config.targetScore;
    const maxScore = Math.max(...this.players.map((p) => p.totalScore));
    if (target && maxScore >= target) {
      this.turnPhase = 'gameEnd';
      this._log('Game over.');
    }
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
      discardPile: this.discardPile.map((c) => publicCard(c)),
      discardTop: this.discardPile[this.discardPile.length - 1] ? publicCard(this.discardPile[this.discardPile.length - 1]) : null,
      headCardId: this.headCardId,
      headCardTaken: this.headCardTaken,
      melds: this.melds.map((m) => ({
        id: m.id,
        type: m.type,
        cards: m.cards.map(publicCard),
        ownerId: m.ownerId,
        faceDownCount: m.faceDownLayoffs.length,
      })),
      mustUseCardIds: [...this.mustUseCardIds],
      spetoWindow: this.spetoWindow
        ? {
            cardId: this.spetoWindow.cardId,
            eligibleForYou: this.spetoWindow.eligiblePlayerIds.includes(viewerId),
            deadline: this.spetoWindow.deadline,
          }
        : null,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        totalScore: p.totalScore,
        roundBonuses: p.roundBonuses,
        penalties: p.penalties,
        connected: p.connected,
        isCurrent: this.players[this.currentPlayerIndex]?.id === p.id,
        // Only reveal own hand
        hand: p.id === viewerId ? p.hand.map(publicCard) : undefined,
      })),
      lastRoundScores: this.lastRoundScores,
      log: this.log.slice(-25),
      config: {
        targetScore: this.config.targetScore,
        aceWrapsAroundKing: this.config.aceWrapsAroundKing,
      },
    };
  }
}

// ---- helpers ----
import { rankIndex as rankIndexOf } from './cards.js';

function publicCard(c) {
  return { id: c.id, suit: c.suit, rank: c.rank, points: c.points };
}

function suitSymbol(suit) {
  return { spade: '♠', heart: '♥', diamond: '♦', club: '♣' }[suit] || suit;
}

function cardLabel(c) {
  return `${c.rank}${suitSymbol(c.suit)}`;
}
