import { canLayOff, findMeldCombosWithCard } from './melds.js';

// Check whether discarding `card` counts as "stupid" per spec:
// - There exist 2+ cards on the PUBLIC table that combine with `card` to form a valid meld.
//   Public cards = existing melds' cards + previously discarded cards (excluding the just-discarded card itself).
// - OR the discarded card can be laid off onto an existing meld (obvious feed).
// Not stupid: the 2 matching cards were only in the discarder's own hand.
//
// This is a defensible interpretation of the spec's "2 cards waiting in the middle publicly".
export function isStupidDiscard(card, gameState) {
  const config = gameState.config || {};
  const melds = gameState.melds || [];

  // (a) layoff-able onto an existing meld → obvious feed
  for (const m of melds) {
    if (canLayOff(card, m, config)) return { stupid: true, reason: 'layoff', meldId: m.id };
  }

  // (b) 2 public cards + card form a valid meld
  // Public pool = flatten all meld cards + discard pile (excluding this newly discarded card if it was just added)
  const publicCards = [];
  for (const m of melds) publicCards.push(...m.cards);
  // Include discard pile cards visible below the top (we allow all previously discarded cards to count as "seen")
  const discard = gameState.discardPile || [];
  // Exclude the just-discarded card from public pool
  for (const c of discard) {
    if (c.id !== card.id) publicCards.push(c);
  }

  const combos = findMeldCombosWithCard(card, publicCards, config);
  if (combos.length > 0) return { stupid: true, reason: 'complete-meld', combo: combos[0] };

  return { stupid: false };
}
