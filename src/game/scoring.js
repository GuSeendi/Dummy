import { isSpeto, cardPoints } from './cards.js';

export const BONUS_HEAD = 50;
export const BONUS_HEAD_SPETO = 100;
export const BONUS_KNOCK = 50;
export const PENALTY = 50; // each negative event
export const MULT_BLIND = 2;
export const MULT_COLOR = 2;
export const MULT_BLIND_COLOR = 4;
export const DARK_NEGATIVE_MULT = -2;

// Compute per-card score for a specific card placement, given whether it was the head card.
export function scoreForPlacedCard(card, headCardId) {
  const isHead = headCardId && card.id === headCardId;
  if (isHead) return isSpeto(card) ? BONUS_HEAD_SPETO : BONUS_HEAD;
  // Non-head card: speto = 50, else normal
  return cardPoints(card);
}

// Calculate final round scores.
//
// gameState (partial shape used):
//   players: [{ id, name, hasMelded, penalties:[{type}], knockType?, cardsPlaced: Card[] }]
//   melds: [{ cards, contributions: { cardId -> playerId } }]
//   headCardId
//   knockerId
export function calculateScores(gameState) {
  const results = [];
  const knockerId = gameState.knockerId || null;

  // First pass: raw meld points per player (sum of card values for cards they placed)
  const meldPoints = new Map(); // playerId -> pts
  for (const m of gameState.melds) {
    for (const c of m.cards) {
      const ownerId = m.contributions?.[c.id];
      if (!ownerId) continue;
      const pts = scoreForPlacedCard(c, gameState.headCardId);
      meldPoints.set(ownerId, (meldPoints.get(ownerId) || 0) + pts);
    }
  }

  for (const p of gameState.players) {
    const meldPts = meldPoints.get(p.id) || 0;
    const penaltyEvents = (p.penalties || []);
    const penaltyPts = penaltyEvents.length * PENALTY;

    let knockBonus = 0;
    let multiplier = 1;
    let darkNegative = false;

    if (p.id === knockerId && p.knockType) {
      knockBonus = BONUS_KNOCK;
      if (p.knockType === 'blindColor') multiplier = MULT_BLIND_COLOR;
      else if (p.knockType === 'color') multiplier = MULT_COLOR;
      else if (p.knockType === 'blind') multiplier = MULT_BLIND;
      // else 'normal' -> multiplier stays 1
    }

    // ลบมืด: if this player never melded AND someone else knocked (not them)
    if (knockerId && p.id !== knockerId && !p.hasMelded) {
      darkNegative = true;
    }

    // Order of ops: (meldPts + knockBonus) * multiplier, then subtract penalties.
    // (Multiplier applies only to knocker's score per spec.)
    // Then if darkNegative applies (only for non-knockers), multiply the whole net by -2.
    let net = (meldPts + knockBonus) * multiplier - penaltyPts;
    if (darkNegative) net = net * DARK_NEGATIVE_MULT;

    results.push({
      playerId: p.id,
      name: p.name,
      meldPts,
      knockBonus,
      multiplier,
      penaltyEvents,
      penaltyPts,
      darkNegative,
      knockType: p.knockType || null,
      net,
    });
  }
  return results;
}
