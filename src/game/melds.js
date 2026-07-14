import { RANK_ORDER, rankIndex } from './cards.js';

// Returns 'set' | 'run' | null
export function classifyMeld(cards, config = {}) {
  if (!Array.isArray(cards) || cards.length < 3) return null;

  // Set: same rank, all distinct suits
  if (cards.every((c) => c.rank === cards[0].rank)) {
    const suits = new Set(cards.map((c) => c.suit));
    if (suits.size === cards.length && suits.size <= 4) return 'set';
    return null;
  }

  // Run: same suit, consecutive ranks
  if (cards.every((c) => c.suit === cards[0].suit)) {
    const idxs = cards.map((c) => rankIndex(c.rank)).sort((a, b) => a - b);
    // Ensure unique consecutive
    for (let i = 1; i < idxs.length; i++) {
      if (idxs[i] !== idxs[i - 1] + 1) {
        // If wrap-around Ace enabled, allow K -> A (index 12 -> 0) at end only
        if (config.aceWrapsAroundKing && idxs[i - 1] === 12 && idxs[i] === 0 && i === idxs.length - 1) continue;
        return null;
      }
    }
    return 'run';
  }
  return null;
}

export function isValidMeld(cards, config = {}) {
  return classifyMeld(cards, config) !== null;
}

// Can `card` be laid off onto an existing meld?
export function canLayOff(card, meld, config = {}) {
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
    if (ci === lo - 1 || ci === hi + 1) return true;
    if (config.aceWrapsAroundKing) {
      // K at top, adding A at end; or A at bottom, adding K at start.
      if (hi === 12 && ci === 0) return true;
      if (lo === 0 && ci === 12) return true;
    }
    return false;
  }
  return false;
}

// Add card to meld's ordered card list, preserving order.
export function addToMeld(meld, card) {
  const newCards = [...meld.cards, card];
  if (meld.type === 'set') {
    return { ...meld, cards: newCards };
  }
  // Run: sort by rank
  newCards.sort((a, b) => rankIndex(a.rank) - rankIndex(b.rank));
  return { ...meld, cards: newCards };
}

// Check if a card can be laid off on ANY current meld (any player)
export function anyLayoffTarget(card, melds, config = {}) {
  return melds.some((m) => canLayOff(card, m, config));
}

// Given a set of hand cards + one candidate card, can we form a valid meld of 3+ using exactly 3 cards (candidate + 2 from hand)?
// Returns list of possible 2-card combos from hand that form a valid meld with candidate.
export function findMeldCombosWithCard(candidate, hand, config = {}) {
  const combos = [];
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      const trio = [candidate, hand[i], hand[j]];
      if (isValidMeld(trio, config)) combos.push([hand[i], hand[j]]);
    }
  }
  return combos;
}
