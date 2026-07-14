export const SUITS = ['spade', 'heart', 'diamond', 'club'];
// A is HIGH (Q-K-A allowed as a run tail; A-2-3 not allowed)
export const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export const SPETO_IDS = new Set(['club-2', 'spade-Q']);

export function isSpeto(card) {
  return SPETO_IDS.has(card.id);
}

// Base per-card points used when the card is placed in a meld/layoff.
// Speto cards always override to 50.
export function cardPoints(card) {
  if (isSpeto(card)) return 50;
  if (card.rank === 'A') return 15;
  if (card.rank === '10' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 10;
  return 5;
}

export function cardId(suit, rank) {
  return `${suit}-${rank}`;
}

export function makeDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANK_ORDER) {
      const c = { id: cardId(suit, rank), suit, rank };
      c.points = cardPoints(c);
      c.isSpeto = isSpeto(c);
      cards.push(c);
    }
  }
  return cards;
}

export function shuffle(cards) {
  const arr = [...cards];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function rankIndex(rank) {
  return RANK_ORDER.indexOf(rank);
}

export function suitSymbol(suit) {
  return { spade: '♠', heart: '♥', diamond: '♦', club: '♣' }[suit] || suit;
}

export function cardLabel(c) {
  return `${c.rank}${suitSymbol(c.suit)}`;
}
