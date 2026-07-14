import { classifyMeld, findMeldCombosWithCard } from './melds.js';
import { isSpeto } from './cards.js';

// ทิ้งเต็ม: discarding a card such that there are already 2+ cards in the
// discard pile (excluding this discard) that together form a valid meld with it.
export function isTingTem(card, discardPileBeforeThis) {
  const combos = findMeldCombosWithCard(card, discardPileBeforeThis);
  return combos.length > 0;
}

// Check if the given card could be laid off onto any existing meld or combined
// with 2 cards from a target player's hand to form a new meld. Returns true if
// there's any legal way the target could immediately use the card.
export function couldBeUsedBy(card, targetPlayer, melds) {
  // Layoff: only if player has already melded this round
  if (targetPlayer.hasMelded) {
    for (const m of melds) {
      if (canLayOffCheap(card, m)) return true;
    }
  }
  // New meld: at least 2 cards in hand combine with it
  if (findMeldCombosWithCard(card, targetPlayer.hand).length > 0) return true;
  return false;
}

function canLayOffCheap(card, meld) {
  if (!meld.cards.length) return false;
  if (meld.type === 'set') {
    if (card.rank !== meld.cards[0].rank) return false;
    return !meld.cards.some((c) => c.suit === card.suit);
  }
  // run
  if (card.suit !== meld.cards[0].suit) return false;
  // extend by 1 at either end
  const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const idxs = meld.cards.map((c) => RANK_ORDER.indexOf(c.rank)).sort((a,b)=>a-b);
  const lo = idxs[0], hi = idxs[idxs.length - 1];
  const ci = RANK_ORDER.indexOf(card.rank);
  return ci === lo - 1 || ci === hi + 1;
}

// A card was "part of the head meld" if the head card was placed in a meld
// together with this card. Used to decide ทิ้งปี้หัว.
export function wasPairedWithHead(card, melds, headCardId) {
  for (const m of melds) {
    if (m.cards.some((c) => c.id === headCardId) && m.cards.some((c) => c.id === card.id)) return true;
  }
  return false;
}

export { isSpeto };
