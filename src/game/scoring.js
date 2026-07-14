import { sumPoints } from './cards.js';

export const BONUS_SPETO = 50;
export const BONUS_HEAD = 50;
export const BONUS_KNOCK = 50;
export const BONUS_FACE_DOWN_LAYOFF = 50;
export const PENALTY_STUPID = 50;

// Compute round score deltas for each player based on their end-of-round state.
// gameState.players[i] must have: hand, roundBonuses (array of {type, points}), penalties (number of stupid events)
export function calculateRoundScores(gameState) {
  const results = [];
  for (const p of gameState.players) {
    const handPenalty = sumPoints(p.hand); // sum of remaining card points
    const bonusTotal = (p.roundBonuses || []).reduce((s, b) => s + (b.points || 0), 0);
    const stupidPenalty = (p.penalties || 0) * PENALTY_STUPID;
    const net = bonusTotal - handPenalty - stupidPenalty;
    results.push({
      playerId: p.id,
      name: p.name,
      handPenalty,
      bonusTotal,
      stupidPenalty,
      bonuses: p.roundBonuses || [],
      penalties: p.penalties || 0,
      net,
    });
  }
  return results;
}
