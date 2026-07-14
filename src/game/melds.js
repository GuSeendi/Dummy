import { RANK_ORDER, rankIndex } from './cards.js';

// Returns 'set' | 'run' | null
export function classifyMeld(cards) {
  if (!Array.isArray(cards) || cards.length < 3) return null;

  // Set: same rank, all different suits
  if (cards.every((c) => c.rank === cards[0].rank)) {
    const suits = new Set(cards.map((c) => c.suit));
    if (suits.size === cards.length && suits.size <= 4) return 'set';
    return null;
  }

  // Run: same suit, consecutive ranks (A is high, at the end)
  if (cards.every((c) => c.suit === cards[0].suit)) {
    const idxs = cards.map((c) => rankIndex(c.rank)).sort((a, b) => a - b);
    for (let i = 1; i < idxs.length; i++) {
      if (idxs[i] !== idxs[i - 1] + 1) return null;
    }
    return 'run';
  }
  return null;
}

export function isValidMeld(cards) {
  return classifyMeld(cards) !== null;
}

export function canLayOff(card, meld) {
  if (!meld || !meld.cards || meld.cards.length === 0) return false;
  if (meld.type === 'set') {
    if (card.rank !== meld.cards[0].rank) return false;
    const suits = new Set(meld.cards.map((c) => c.suit));
    return !suits.has(card.suit);
  }
  if (meld.type === 'run') {
    if (card.suit !== meld.cards[0].suit) return false;
    const idxs = meld.cards.map((c) => rankIndex(c.rank)).sort((a, b) => a - b);
    const lo = idxs[0];
    const hi = idxs[idxs.length - 1];
    const ci = rankIndex(card.rank);
    return ci === lo - 1 || ci === hi + 1;
  }
  return false;
}

export function addToMeld(meld, card) {
  const newCards = [...meld.cards, card];
  if (meld.type === 'run') newCards.sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank));
  return { ...meld, cards: newCards };
}

// Find all 2-card combos in `hand` that form a valid meld with `candidate`.
export function findMeldCombosWithCard(candidate, hand) {
  const combos = [];
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      const trio = [candidate, hand[i], hand[j]];
      if (isValidMeld(trio)) combos.push([hand[i], hand[j]]);
    }
  }
  return combos;
}
