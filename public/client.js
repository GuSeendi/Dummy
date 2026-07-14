const socket = io();
const app = document.getElementById('app');

const SUIT_SYM = { spade: '♠', heart: '♥', diamond: '♦', club: '♣' };
const SUIT_RED = new Set(['heart', 'diamond']);
const RANK_ORDER = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

let state = null;
let roomCode = null;
let hostId = null;
let myId = null;
let selectedIds = new Set();
let pendingLayoff = null; // { cardId } waiting for user to click a meld
let spetoTicker = null;

function view(id) {
  const tpl = document.getElementById(id);
  return tpl.content.cloneNode(true);
}

function render() {
  if (!state) {
    renderLobby();
    return;
  }
  const phase = state.turnPhase;
  if (phase === 'lobby') {
    renderWaiting();
  } else {
    renderGame();
  }
}

// ---------- LOBBY ----------
function renderLobby() {
  app.innerHTML = '';
  app.appendChild(view('tpl-lobby'));
  const savedName = localStorage.getItem('dummy_name') || '';
  document.getElementById('name-input').value = savedName;
  document.getElementById('btn-create').onclick = () => {
    const name = document.getElementById('name-input').value.trim() || 'Player';
    const config = {
      targetScore: parseInt(document.getElementById('cfg-target').value, 10) || 300,
      aceWrapsAroundKing: document.getElementById('cfg-wrap').checked,
    };
    localStorage.setItem('dummy_name', name);
    socket.emit('createRoom', { name, config }, (r) => handleJoinAck(r));
  };
  document.getElementById('btn-join').onclick = () => {
    const name = document.getElementById('name-input').value.trim() || 'Player';
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (!code) return showLobbyErr('Enter a room code.');
    localStorage.setItem('dummy_name', name);
    socket.emit('joinRoom', { name, code }, (r) => handleJoinAck(r));
  };
}

function handleJoinAck(r) {
  if (!r?.ok) return showLobbyErr(r?.error || 'Failed');
  roomCode = r.roomCode;
}
function showLobbyErr(m) {
  const el = document.getElementById('lobby-err');
  if (el) el.textContent = m;
}

// ---------- WAITING ----------
function renderWaiting() {
  app.innerHTML = '';
  app.appendChild(view('tpl-waiting'));
  document.getElementById('room-code').textContent = roomCode;
  const list = document.getElementById('waiting-players');
  list.innerHTML = '';
  for (const p of state.players) {
    const el = document.createElement('div');
    el.className = 'player-chip' + (p.id === hostId ? ' host' : '');
    el.textContent = p.name + (p.id === myId ? ' (you)' : '');
    list.appendChild(el);
  }
  const startBtn = document.getElementById('btn-start');
  if (myId === hostId) {
    startBtn.disabled = state.players.length < 2;
    startBtn.onclick = () => socket.emit('startGame', {}, (r) => { if (!r?.ok) alert(r?.error); });
  } else {
    startBtn.disabled = true;
    startBtn.textContent = 'Waiting for host…';
  }
  document.getElementById('btn-leave').onclick = () => {
    socket.emit('leaveRoom');
    state = null; roomCode = null; render();
  };
}

// ---------- GAME ----------
function renderGame() {
  const isGame = document.querySelector('.game');
  if (!isGame) { app.innerHTML = ''; app.appendChild(view('tpl-game')); wireGameButtons(); }
  document.getElementById('g-code').textContent = roomCode;
  document.getElementById('g-round').textContent = state.roundNumber;
  const isMyTurn = state.currentPlayerId === myId;
  const phaseLabel = phaseHumanLabel(state, isMyTurn);
  document.getElementById('g-phase').textContent = phaseLabel;

  renderOpponents();
  renderMelds();
  renderPiles();
  renderMyHand();
  renderScores();
  renderLog();
  renderSpeto();
  renderRoundEnd();
  renderGameEnd();
  updateActionButtons();
}

function phaseHumanLabel(s, isMyTurn) {
  if (s.turnPhase === 'roundEnd') return 'Round ended';
  if (s.turnPhase === 'gameEnd') return 'Game over';
  const cur = s.players.find((p) => p.id === s.currentPlayerId);
  const who = isMyTurn ? 'Your turn' : `${cur?.name || '?'} — `;
  const ph = s.turnPhase === 'draw' ? 'draw' :
             s.turnPhase === 'meld' ? 'meld/discard' :
             s.turnPhase === 'discard' ? 'discard' :
             s.turnPhase === 'spetoWindow' ? 'SPETO window' : s.turnPhase;
  return isMyTurn ? `${who} — ${ph}` : `${who}${ph}`;
}

function wireGameButtons() {
  document.getElementById('btn-leave-g').onclick = () => {
    socket.emit('leaveRoom');
    state = null; roomCode = null; render();
  };
  document.getElementById('stock-pile').onclick = () => {
    socket.emit('drawStock', {}, feedbackAck);
  };
  document.getElementById('discard-pile').onclick = () => {
    socket.emit('drawDiscard', {}, feedbackAck);
  };
  document.getElementById('btn-draw-head').onclick = (e) => {
    e.stopPropagation();
    socket.emit('drawHead', {}, feedbackAck);
  };
  document.getElementById('btn-meld').onclick = () => {
    if (selectedIds.size < 3) return;
    socket.emit('meld', { cardIds: [...selectedIds] }, (r) => {
      if (r?.ok) selectedIds.clear();
      feedbackAck(r);
    });
  };
  document.getElementById('btn-layoff').onclick = () => {
    if (selectedIds.size !== 1) return;
    pendingLayoff = { cardId: [...selectedIds][0] };
    updateActionButtons();
    alert('Click a meld to lay this card off onto.');
  };
  document.getElementById('btn-discard').onclick = () => {
    if (selectedIds.size !== 1) return;
    socket.emit('discard', { cardId: [...selectedIds][0] }, (r) => {
      if (r?.ok) selectedIds.clear();
      feedbackAck(r);
    });
  };
  document.getElementById('btn-clear').onclick = () => {
    selectedIds.clear();
    pendingLayoff = null;
    render();
  };
  document.getElementById('btn-knock').onclick = openKnockPlanner;
  document.getElementById('speto-cancel').onclick = () => {
    document.getElementById('speto-modal').classList.add('hidden');
  };
  document.getElementById('knock-cancel').onclick = () => {
    document.getElementById('knock-modal').classList.add('hidden');
  };
  document.getElementById('knock-submit').onclick = submitKnockPlan;
  document.getElementById('btn-next-round').onclick = () => {
    socket.emit('nextRound', {}, feedbackAck);
  };
  document.getElementById('btn-leave-final').onclick = () => {
    socket.emit('leaveRoom');
    state = null; roomCode = null; render();
  };
}

function feedbackAck(r) {
  if (!r) return;
  if (!r.ok && r.error) toast(r.error);
}

function renderOpponents() {
  const c = document.getElementById('opponents');
  c.innerHTML = '';
  for (const p of state.players) {
    if (p.id === myId) continue;
    const el = document.createElement('div');
    el.className = 'opponent' + (p.isCurrent ? ' current' : '') + (p.connected ? '' : ' disconnected');
    el.innerHTML = `
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="cards-back">${Array.from({length: p.handCount}).map(() => '<div class="card-back"></div>').join('')}</div>
      <div class="score">Score: ${p.totalScore} | Round: ${sumRound(p)}</div>
      <div class="bonuses">${bonusesLine(p)}</div>
    `;
    c.appendChild(el);
  }
}

function sumRound(p) {
  const bonus = (p.roundBonuses || []).reduce((s, b) => s + (b.points || 0), 0);
  return bonus - (p.penalties || 0) * 50;
}

function bonusesLine(p) {
  const parts = [];
  const bonusCounts = {};
  for (const b of p.roundBonuses || []) bonusCounts[b.type] = (bonusCounts[b.type] || 0) + 1;
  for (const [k, v] of Object.entries(bonusCounts)) parts.push(`${k}×${v}`);
  if (p.penalties > 0) parts.push(`stupid×${p.penalties}`);
  return parts.join(' · ');
}

function renderPiles() {
  document.getElementById('stock-count').textContent = state.stockCount;
  const topEl = document.getElementById('discard-top-card');
  const top = state.discardTop;
  if (top) {
    topEl.innerHTML = renderCardMini(top);
  } else {
    topEl.textContent = '';
  }
  const discardEl = document.getElementById('discard-pile');
  const headBtn = document.getElementById('btn-draw-head');
  const headAvail = !state.headCardTaken && state.headCardId && state.discardPile.some((c) => c.id === state.headCardId);
  discardEl.classList.toggle('head-avail', !!headAvail);
  headBtn.style.display = (headAvail && isMyTurn() && state.turnPhase === 'draw') ? '' : 'none';
}

function isMyTurn() { return state.currentPlayerId === myId; }

function renderMelds() {
  const c = document.getElementById('melds');
  c.innerHTML = '';
  for (const m of state.melds) {
    const owner = state.players.find((p) => p.id === m.ownerId);
    const el = document.createElement('div');
    el.className = 'meld';
    el.innerHTML = `
      <div class="owner">${escapeHtml(owner?.name || '?')} · ${m.type}</div>
      <div class="cards">${m.cards.map(renderCardMini).join('')}
        ${Array.from({length: m.faceDownCount}).map(() => '<div class="card mini facedown"></div>').join('')}
      </div>
      ${m.faceDownCount ? `<div class="facedown-count">🂠 ${m.faceDownCount} face-down</div>` : ''}
    `;
    if (pendingLayoff) el.classList.add('layoff-hint');
    el.onclick = () => {
      if (pendingLayoff) {
        socket.emit('layOff', { cardId: pendingLayoff.cardId, meldId: m.id }, (r) => {
          if (r?.ok) { selectedIds.clear(); pendingLayoff = null; }
          feedbackAck(r);
        });
      }
    };
    c.appendChild(el);
  }
}

function renderMyHand() {
  const me = state.players.find((p) => p.id === myId);
  if (!me?.hand) return;
  const hand = [...me.hand].sort((a, b) => {
    if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
    return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
  });
  document.getElementById('hand-count').textContent = hand.length;
  document.getElementById('hand-points').textContent = hand.reduce((s, c) => s + c.points, 0);
  const mustUseIds = new Set(state.mustUseCardIds || []);
  document.getElementById('mustuse').textContent = mustUseIds.size
    ? `⚠ must use: ${[...mustUseIds].map((id) => cardLabelFromId(id, hand)).join(', ')}`
    : '';
  const c = document.getElementById('myhand');
  c.innerHTML = '';
  for (const card of hand) {
    const el = document.createElement('div');
    el.className = 'card' + (SUIT_RED.has(card.suit) ? ' red' : '') + (selectedIds.has(card.id) ? ' selected' : '');
    if (mustUseIds.has(card.id)) el.style.outline = '2px solid #ff9800';
    el.innerHTML = `<div class="top">${card.rank}${SUIT_SYM[card.suit]}</div><div class="bot">${SUIT_SYM[card.suit]}${card.rank}</div>`;
    el.onclick = () => toggleSelect(card.id);
    c.appendChild(el);
  }
}

function cardLabelFromId(id, hand) {
  const c = hand.find((x) => x.id === id);
  return c ? `${c.rank}${SUIT_SYM[c.suit]}` : id;
}

function toggleSelect(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  pendingLayoff = null;
  render();
}

function updateActionButtons() {
  const myTurn = isMyTurn();
  const phase = state.turnPhase;
  const inMeldPhase = myTurn && phase === 'meld';
  document.getElementById('btn-meld').disabled = !(inMeldPhase && selectedIds.size >= 3);
  document.getElementById('btn-layoff').disabled = !(inMeldPhase && selectedIds.size === 1 && state.melds.length > 0);
  document.getElementById('btn-discard').disabled = !(inMeldPhase && selectedIds.size === 1 && (state.mustUseCardIds || []).length === 0);
  document.getElementById('btn-knock').disabled = !(inMeldPhase);
}

function renderCardMini(card) {
  const red = SUIT_RED.has(card.suit) ? ' red' : '';
  return `<div class="card mini${red}"><div class="top">${card.rank}${SUIT_SYM[card.suit]}</div><div class="bot">${SUIT_SYM[card.suit]}${card.rank}</div></div>`;
}

function renderScores() {
  const c = document.getElementById('scores');
  const rows = state.players.map((p) => `
    <tr class="${p.isCurrent ? 'current' : ''}">
      <td>${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}</td>
      <td>${p.totalScore}</td>
    </tr>
  `).join('');
  c.innerHTML = `<b>Scoreboard</b> (goal ${state.config?.targetScore})
    <table><thead><tr><th>Player</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderLog() {
  const c = document.getElementById('log');
  c.innerHTML = '<b>Game log</b>' + (state.log || []).slice().reverse().map((l) => `<div class="line">${escapeHtml(l.msg)}</div>`).join('');
}

// ---- Speto modal ----
function renderSpeto() {
  const modal = document.getElementById('speto-modal');
  const sw = state.spetoWindow;
  if (!sw || !sw.eligibleForYou) {
    modal.classList.add('hidden');
    if (spetoTicker) { clearInterval(spetoTicker); spetoTicker = null; }
    return;
  }
  const me = state.players.find((p) => p.id === myId);
  if (!me) return;
  const card = state.discardTop;
  document.getElementById('speto-card').innerHTML = card ? renderCardMini(card) : '';
  // Compute combos client-side (same logic)
  const combos = findComboWithCard(card, me.hand || []);
  const box = document.getElementById('speto-combos');
  box.innerHTML = '';
  if (combos.length === 0) {
    box.innerHTML = '<em>No valid combo</em>';
  } else {
    for (const combo of combos) {
      const row = document.createElement('div');
      row.className = 'combo-row';
      row.innerHTML = combo.map(renderCardMini).join('') + ` <span style="margin-left:auto">→ SPETO</span>`;
      row.onclick = () => {
        socket.emit('speto', { comboCardIds: combo.map((c) => c.id) }, (r) => {
          if (r?.ok) modal.classList.add('hidden');
          feedbackAck(r);
        });
      };
      box.appendChild(row);
    }
  }
  modal.classList.remove('hidden');
  updateSpetoTimer(sw.deadline);
  if (spetoTicker) clearInterval(spetoTicker);
  spetoTicker = setInterval(() => updateSpetoTimer(sw.deadline), 200);
}

function updateSpetoTimer(deadline) {
  const el = document.getElementById('speto-timer');
  if (!el) return;
  const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  el.textContent = left;
  if (left <= 0 && spetoTicker) { clearInterval(spetoTicker); spetoTicker = null; }
}

function findComboWithCard(candidate, hand) {
  if (!candidate) return [];
  const combos = [];
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      const trio = [candidate, hand[i], hand[j]];
      if (isValidMeldClient(trio)) combos.push([hand[i], hand[j]]);
    }
  }
  return combos;
}

function isValidMeldClient(cards) {
  if (cards.length < 3) return false;
  if (cards.every((c) => c.rank === cards[0].rank)) {
    const suits = new Set(cards.map((c) => c.suit));
    return suits.size === cards.length;
  }
  if (cards.every((c) => c.suit === cards[0].suit)) {
    const idxs = cards.map((c) => RANK_ORDER.indexOf(c.rank)).sort((a,b) => a-b);
    for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i-1] + 1) return false;
    return true;
  }
  return false;
}

// ---- Round end / game over ----
function renderRoundEnd() {
  const modal = document.getElementById('round-modal');
  if (state.turnPhase !== 'roundEnd' || !state.lastRoundScores) { modal.classList.add('hidden'); return; }
  document.getElementById('round-title').textContent = `Round ${state.roundNumber} results`;
  const rows = state.lastRoundScores.map((s) => `
    <tr><td>${escapeHtml(s.name)}</td>
    <td>-${s.handPenalty}</td>
    <td>+${s.bonusTotal}</td>
    <td>-${s.stupidPenalty}</td>
    <td><b>${s.net >= 0 ? '+' : ''}${s.net}</b></td></tr>
  `).join('');
  document.getElementById('round-scores').innerHTML = `
    <table>
      <thead><tr><th>Player</th><th>Hand</th><th>Bonus</th><th>Stupid</th><th>Net</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  modal.classList.remove('hidden');
  const btn = document.getElementById('btn-next-round');
  btn.style.display = (myId === hostId) ? '' : 'none';
}

function renderGameEnd() {
  const modal = document.getElementById('game-over-modal');
  if (state.turnPhase !== 'gameEnd') { modal.classList.add('hidden'); return; }
  const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore);
  document.getElementById('final-scores').innerHTML = sorted.map((p, i) =>
    `<div>${i === 0 ? '🥇 ' : ''}${escapeHtml(p.name)}: <b>${p.totalScore}</b></div>`
  ).join('');
  modal.classList.remove('hidden');
}

// ---- Knock planner ----
let knockPlan = null;

function openKnockPlanner() {
  const me = state.players.find((p) => p.id === myId);
  if (!me) return;
  knockPlan = {
    // For each hand card, assignment: 'meld'|'layoff'|'facedown'|'discard' + target
    assignments: {}, // cardId -> {kind, meldId?, groupId?}
  };
  // preselect selected cards as first new meld group
  renderKnockPlanner();
  document.getElementById('knock-modal').classList.remove('hidden');
  document.getElementById('knock-err').textContent = '';
}

function renderKnockPlanner() {
  const me = state.players.find((p) => p.id === myId);
  const hand = [...(me.hand || [])].sort((a, b) => {
    if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
    return RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank);
  });
  const wrapper = document.getElementById('knock-planner');
  wrapper.innerHTML = '';

  // Group meld options: existing melds for layoff/facedown, plus "new meld group N" for meld
  const meldGroups = new Set(); // grouping IDs for new melds
  for (const a of Object.values(knockPlan.assignments)) {
    if (a.kind === 'meld' && a.groupId) meldGroups.add(a.groupId);
  }

  for (const card of hand) {
    const asg = knockPlan.assignments[card.id] || { kind: '' };
    const row = document.createElement('div');
    row.className = 'assign-row';
    const suit = SUIT_RED.has(card.suit) ? ' red' : '';
    row.innerHTML = `<div class="card mini${suit}"><div class="top">${card.rank}${SUIT_SYM[card.suit]}</div><div class="bot">${SUIT_SYM[card.suit]}${card.rank}</div></div>`;
    // kind select
    const kindSel = document.createElement('select');
    kindSel.innerHTML = `
      <option value="">— assign —</option>
      <option value="meld"${asg.kind==='meld'?' selected':''}>New meld</option>
      <option value="layoff"${asg.kind==='layoff'?' selected':''}>Layoff</option>
      <option value="facedown"${asg.kind==='facedown'?' selected':''}>Face-down layoff (+50)</option>
      <option value="discard"${asg.kind==='discard'?' selected':''}>Discard (last card)</option>
    `;
    kindSel.onchange = () => {
      knockPlan.assignments[card.id] = { kind: kindSel.value };
      renderKnockPlanner();
    };
    row.appendChild(kindSel);

    // target
    if (asg.kind === 'meld') {
      const grpSel = document.createElement('select');
      const options = ['<option value="">— pick group —</option>'];
      for (const g of meldGroups) options.push(`<option value="${g}"${asg.groupId===g?' selected':''}>Meld ${g}</option>`);
      options.push(`<option value="__new">+ new meld group</option>`);
      grpSel.innerHTML = options.join('');
      grpSel.onchange = () => {
        let g = grpSel.value;
        if (g === '__new') {
          const nextId = (Math.max(0, ...[...meldGroups].map((x) => parseInt(x, 10) || 0)) + 1).toString();
          g = nextId;
        }
        knockPlan.assignments[card.id] = { kind: 'meld', groupId: g };
        renderKnockPlanner();
      };
      row.appendChild(grpSel);
    }
    if (asg.kind === 'layoff' || asg.kind === 'facedown') {
      const meldSel = document.createElement('select');
      const opts = ['<option value="">— pick meld —</option>'];
      for (const m of state.melds) {
        const owner = state.players.find((p) => p.id === m.ownerId);
        opts.push(`<option value="${m.id}"${asg.meldId===m.id?' selected':''}>${owner?.name || '?'} ${m.type}: ${m.cards.map((c) => c.rank+SUIT_SYM[c.suit]).join(' ')}</option>`);
      }
      meldSel.innerHTML = opts.join('');
      meldSel.onchange = () => {
        knockPlan.assignments[card.id] = { kind: asg.kind, meldId: meldSel.value };
        renderKnockPlanner();
      };
      row.appendChild(meldSel);
    }

    wrapper.appendChild(row);
  }

  // Live summary
  const summary = document.createElement('div');
  summary.className = 'knock-section';
  const groups = {};
  const layoffs = [];
  const fds = [];
  let discardCardId = null;
  const unassigned = [];
  for (const c of hand) {
    const a = knockPlan.assignments[c.id];
    if (!a || !a.kind) { unassigned.push(c); continue; }
    if (a.kind === 'meld') {
      if (!a.groupId) unassigned.push(c);
      else { groups[a.groupId] = groups[a.groupId] || []; groups[a.groupId].push(c); }
    } else if (a.kind === 'layoff') {
      if (!a.meldId) unassigned.push(c); else layoffs.push({ cardId: c.id, meldId: a.meldId });
    } else if (a.kind === 'facedown') {
      if (!a.meldId) unassigned.push(c); else fds.push({ cardId: c.id, meldId: a.meldId });
    } else if (a.kind === 'discard') {
      if (discardCardId) { /* dup — will fail validation */ }
      discardCardId = c.id;
    }
  }
  const meldPlan = Object.values(groups).map((cards) => cards.map((c) => c.id));
  summary.innerHTML = `<h4>Plan summary</h4>
    <div>New melds: ${meldPlan.length}</div>
    <div>Layoffs: ${layoffs.length}</div>
    <div>Face-down layoffs (+50 each): ${fds.length}</div>
    <div>Discard: ${discardCardId ? cardLabelFromId(discardCardId, hand) : '—'}</div>
    <div>Unassigned: ${unassigned.length}</div>
  `;
  wrapper.appendChild(summary);

  // Store computed for submit
  knockPlan._compiled = { melds: meldPlan, layoffs, faceDownLayoffs: fds, discardCardId };
}

function submitKnockPlan() {
  const plan = knockPlan?._compiled;
  if (!plan) return;
  socket.emit('knockPlan', { plan }, (r) => {
    if (r?.ok) {
      document.getElementById('knock-modal').classList.add('hidden');
      selectedIds.clear();
    } else {
      document.getElementById('knock-err').textContent = r?.error || 'Failed';
    }
  });
}

// ---- utility ----
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#b71c1c;color:#fff;padding:0.5em 1em;border-radius:4px;z-index:200';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ---- socket wiring ----
socket.on('connect', () => {
  myId = socket.id;
  render();
});

socket.on('state', ({ roomCode: rc, hostId: hi, state: s }) => {
  roomCode = rc;
  hostId = hi;
  state = s;
  render();
});

socket.on('disconnect', () => {
  toast('Disconnected from server.');
});
