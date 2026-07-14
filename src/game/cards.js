export const SUITS = ['spade', 'heart', 'diamond', 'club'];
export const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function cardPoints(rank) {
  if (rank === 'A') return 15;
  if (rank === '10' || rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return 5;
}

export function cardId(suit, rank) {
  return `${suit}-${rank}`;
}

export function makeDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (const rank of RANK_ORDER) {
      cards.push({ id: cardId(suit, rank), suit, rank, points: cardPoints(rank) });
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

export function sumPoints(cards) {
  return cards.reduce((s, c) => s + c.points, 0);
}
