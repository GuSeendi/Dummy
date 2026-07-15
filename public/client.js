const socket = io();
const app = document.getElementById('app');

const SUIT_SYM = { spade: '♠', heart: '♥', diamond: '♦', club: '♣' };
const SUIT_RED = new Set(['heart', 'diamond']);
const RANK_ORDER = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SPETO_IDS = new Set(['club-2', 'spade-Q']);

let state = null;
let roomCode = null;
let hostId = null;
let myId = null;
let selectedIds = new Set();
let pendingLayoff = null;
let handOrder = []; // local per-client card order; user-draggable
let dragCardId = null;

function view(id) {
  const tpl = document.getElementById(id);
  return tpl.content.cloneNode(true);
}

function render() {
  if (!state) { renderLobby(); return; }
  if (state.turnPhase === 'lobby') renderWaiting();
  else renderGame();
}

// ---------- LOBBY ----------
function renderLobby() {
  app.innerHTML = '';
  app.appendChild(view('tpl-lobby'));
  const savedName = localStorage.getItem('dummy_name') || '';
  document.getElementById('name-input').value = savedName;
  document.getElementById('btn-create').onclick = () => {
    const name = document.getElementById('name-input').value.trim() || 'Player';
    localStorage.setItem('dummy_name', name);
    socket.emit('createRoom', { name, config: {} }, handleJoinAck);
  };
  document.getElementById('btn-join').onclick = () => {
    const name = document.getElementById('name-input').value.trim() || 'Player';
    const code = document.getElementById('code-input').value.trim().toUpperCase();
    if (!code) return showLobbyErr('ใส่รหัสห้องก่อน');
    localStorage.setItem('dummy_name', name);
    socket.emit('joinRoom', { name, code }, handleJoinAck);
  };
}
function handleJoinAck(r) { if (!r?.ok) return showLobbyErr(r?.error || 'ล้มเหลว'); roomCode = r.roomCode; }
function showLobbyErr(m) { const el = document.getElementById('lobby-err'); if (el) el.textContent = m; }

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
    el.textContent = p.name + (p.id === myId ? ' (คุณ)' : '');
    list.appendChild(el);
  }
  const startBtn = document.getElementById('btn-start');
  if (myId === hostId) {
    startBtn.disabled = state.players.length < 2;
    startBtn.onclick = () => socket.emit('startGame', {}, (r) => { if (!r?.ok) alert(r?.error); });
  } else {
    startBtn.disabled = true;
    startBtn.textContent = 'รอเจ้าของห้อง…';
  }
  document.getElementById('btn-leave').onclick = leaveRoom;
}

function leaveRoom() {
  socket.emit('leaveRoom');
  state = null; roomCode = null; selectedIds.clear(); pendingLayoff = null; render();
}

// ---------- GAME ----------
function renderGame() {
  if (!document.querySelector('.game')) { app.innerHTML = ''; app.appendChild(view('tpl-game')); wireGameButtons(); }
  document.getElementById('g-code').textContent = roomCode;
  document.getElementById('g-round').textContent = state.roundNumber;
  document.getElementById('g-phase').textContent = phaseLabel();
  renderOpponents();
  renderMelds();
  renderPiles();
  renderMyHand();
  renderScores();
  renderLog();
  renderRoundEnd();
  updateActionButtons();
}

function phaseLabel() {
  if (state.turnPhase === 'roundEnd') return 'จบรอบ';
  const cur = state.players.find((p) => p.id === state.currentPlayerId);
  const mine = state.currentPlayerId === myId;
  const ph = state.turnPhase === 'draw' ? 'จั่ว/เก็บ' : state.turnPhase === 'meld' ? 'เกิด/ฝาก/ทิ้ง' : state.turnPhase;
  return mine ? `ตาคุณ — ${ph}` : `${cur?.name || '?'} — ${ph}`;
}

function wireGameButtons() {
  document.getElementById('btn-leave-g').onclick = leaveRoom;
  document.getElementById('stock-pile').onclick = () => socket.emit('drawStock', {}, feedbackAck);
  document.getElementById('btn-meld').onclick = () => {
    if (selectedIds.size < 3) return;
    socket.emit('meld', { cardIds: [...selectedIds] }, (r) => { if (r?.ok) selectedIds.clear(); feedbackAck(r); });
  };
  document.getElementById('btn-layoff').onclick = () => {
    if (selectedIds.size !== 1) return;
    pendingLayoff = { cardId: [...selectedIds][0] };
    updateActionButtons();
    toast('กดที่กองที่ต้องการฝาก');
  };
  document.getElementById('btn-discard').onclick = () => {
    if (selectedIds.size !== 1) return;
    socket.emit('discard', { cardId: [...selectedIds][0] }, (r) => { if (r?.ok) selectedIds.clear(); feedbackAck(r); });
  };
  document.getElementById('btn-clear').onclick = () => { selectedIds.clear(); pendingLayoff = null; render(); };
  document.getElementById('btn-next-round').onclick = () => socket.emit('nextRound', {}, feedbackAck);
  document.getElementById('btn-leave-round').onclick = leaveRoom;
}

function feedbackAck(r) { if (!r) return; if (!r.ok && r.error) toast(r.error); }

function renderOpponents() {
  const c = document.getElementById('opponents');
  c.innerHTML = '';
  for (const p of state.players) {
    if (p.id === myId) continue;
    const el = document.createElement('div');
    el.className = 'opponent' + (p.isCurrent ? ' current' : '') + (p.connected ? '' : ' disconnected');
    const meldedTag = p.hasMelded ? '<span class="tag good">เกิดแล้ว</span>' : '<span class="tag warn">ยังไม่เกิด</span>';
    const pens = penaltiesLine(p);
    el.innerHTML = `
      <div class="name">${escapeHtml(p.name)} ${meldedTag}</div>
      <div class="cards-back">${Array.from({length: p.handCount}).map(()=>'<div class="card-back"></div>').join('')}</div>
      <div class="score">แต้มรวม: ${p.totalScore}</div>
      ${pens ? `<div class="bonuses">${pens}</div>` : ''}
    `;
    c.appendChild(el);
  }
}

function penaltiesLine(p) {
  const counts = {};
  for (const x of p.penalties || []) counts[x.type] = (counts[x.type]||0)+1;
  const label = { tingMee: 'ทิ้งมี่', piHua: 'ปี้หัว', tem: 'ทิ้งเต็ม', spetoLayoff: 'ถูกฝากสเปโต', stupid: 'ทิ้งโง่' };
  return Object.entries(counts).map(([k,v]) => `${label[k]||k}×${v}`).join(' · ');
}

function renderPiles() {
  document.getElementById('stock-count').textContent = state.stockCount;
  const row = document.getElementById('discard-row');
  row.innerHTML = '';
  const pile = state.discardPile || [];
  const canPick = isMyTurn() && state.turnPhase === 'draw';
  if (pile.length === 0) {
    row.innerHTML = '<em style="color:#888">— ยังไม่มีไพ่ในกองทิ้ง —</em>';
    return;
  }
  pile.forEach((card, i) => {
    const isTop = i === pile.length - 1;
    const isHead = card.id === state.headCardId;
    const red = SUIT_RED.has(card.suit) ? ' red' : '';
    const speto = SPETO_IDS.has(card.id) ? ' speto' : '';
    const takeCount = pile.length - i; // pick this card + everything after
    const el = document.createElement('div');
    el.className = `card mini${red}${speto}${isTop ? ' top' : ''}${canPick ? ' pickable' : ''}`;
    el.innerHTML = `<div class="top">${card.rank}${SUIT_SYM[card.suit]}</div><div class="bot">${SUIT_SYM[card.suit]}${card.rank}</div>` +
      (isHead ? `<div class="head-tag">หัว${SPETO_IDS.has(card.id) ? ' +100' : ' +50'}</div>` : '') +
      (canPick && !isTop ? `<div class="take-badge">+${takeCount - 1}</div>` : '');
    if (canPick) {
      el.title = isTop ? 'เก็บใบบนสุด (ต้องเกิด)' : `เก็บใบนี้ + พ่วง ${takeCount - 1} ใบด้านบน (ต้องเกิดใบนี้)`;
      el.onclick = () => socket.emit('drawDiscard', { targetCardId: card.id }, feedbackAck);
    }
    row.appendChild(el);
  });
}

function isMyTurn() { return state.currentPlayerId === myId; }

function renderMelds() {
  const c = document.getElementById('melds');
  c.innerHTML = '';
  if (!state.melds.length) { c.innerHTML = '<em style="color:#888">— ยังไม่มีชุดบนโต๊ะ —</em>'; return; }
  for (const m of state.melds) {
    const el = document.createElement('div');
    el.className = 'meld';
    // owner label: unique contributor names
    const owners = new Set(Object.values(m.contributions || {}));
    const ownerNames = [...owners].map((id) => state.players.find((p) => p.id === id)?.name || '?').join(', ');
    el.innerHTML = `
      <div class="owner">${escapeHtml(ownerNames)} · ${m.type}</div>
      <div class="cards">${m.cards.map((c) => renderCardMini(c, state.headCardId, m.contributions?.[c.id])).join('')}</div>
    `;
    if (pendingLayoff) el.classList.add('layoff-hint');
    el.onclick = () => {
      if (!pendingLayoff) return;
      socket.emit('layOff', { cardId: pendingLayoff.cardId, meldId: m.id }, (r) => {
        if (r?.ok) { selectedIds.clear(); pendingLayoff = null; }
        feedbackAck(r);
      });
    };
    c.appendChild(el);
  }
}

function reconcileHandOrder(handCards) {
  const currentIds = new Set(handCards.map((c) => c.id));
  handOrder = handOrder.filter((id) => currentIds.has(id));
  for (const c of handCards) if (!handOrder.includes(c.id)) handOrder.push(c.id);
}

function renderMyHand() {
  const me = state.players.find((p) => p.id === myId);
  if (!me?.hand) return;
  reconcileHandOrder(me.hand);
  const byId = Object.fromEntries(me.hand.map((c) => [c.id, c]));
  const hand = handOrder.map((id) => byId[id]).filter(Boolean);
  document.getElementById('hand-count').textContent = hand.length;
  const mustMeld = new Set(state.mustMeldCardIds || []);
  document.getElementById('mustuse').innerHTML = mustMeld.size
    ? `⚠ ต้องเกิดใบนี้เทิร์นนี้: ${[...mustMeld].map((id) => labelCardId(id, hand)).join(', ')}`
    : '';
  const c = document.getElementById('myhand');
  c.innerHTML = '';
  hand.forEach((card, idx) => {
    const el = document.createElement('div');
    const red = SUIT_RED.has(card.suit) ? ' red' : '';
    const speto = SPETO_IDS.has(card.id) ? ' speto' : '';
    const isHead = card.id === state.headCardId;
    const selected = selectedIds.has(card.id) ? ' selected' : '';
    el.className = `card${red}${speto}${selected}${isHead ? ' head-mark' : ''}`;
    if (mustMeld.has(card.id)) el.style.outlineColor = '#ff9800';
    el.dataset.cardId = card.id;
    el.draggable = true;
    el.innerHTML = `<div class="top">${card.rank}${SUIT_SYM[card.suit]}</div><div class="bot">${SUIT_SYM[card.suit]}${card.rank}</div>${card.drawn ? '<div class="drawn-dot" title="ไพ่ที่จั่วมา"></div>' : ''}`;
    el.onclick = () => toggleSelect(card.id);
    el.ondragstart = (e) => { dragCardId = card.id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', card.id); } catch {} el.classList.add('dragging'); };
    el.ondragend = () => { el.classList.remove('dragging'); dragCardId = null; document.querySelectorAll('.myhand .drop-before').forEach((n) => n.classList.remove('drop-before')); };
    el.ondragover = (e) => { if (dragCardId && dragCardId !== card.id) { e.preventDefault(); el.classList.add('drop-before'); } };
    el.ondragleave = () => el.classList.remove('drop-before');
    el.ondrop = (e) => {
      e.preventDefault();
      el.classList.remove('drop-before');
      const draggedId = dragCardId || e.dataTransfer.getData('text/plain');
      if (!draggedId || draggedId === card.id) return;
      const from = handOrder.indexOf(draggedId);
      let to = handOrder.indexOf(card.id);
      if (from === -1 || to === -1) return;
      handOrder.splice(from, 1);
      to = handOrder.indexOf(card.id); // recompute after splice
      handOrder.splice(to, 0, draggedId);
      render();
    };
    c.appendChild(el);
  });
  // Drop at end of hand (for dropping past the last card)
  const c2 = document.getElementById('myhand');
  c2.ondragover = (e) => { if (dragCardId) e.preventDefault(); };
  c2.ondrop = (e) => {
    if (e.target !== c2) return; // already handled by a card
    e.preventDefault();
    const draggedId = dragCardId || e.dataTransfer.getData('text/plain');
    if (!draggedId) return;
    const from = handOrder.indexOf(draggedId);
    if (from === -1) return;
    handOrder.splice(from, 1);
    handOrder.push(draggedId);
    render();
  };
}

function labelCardId(id, hand) { const c = hand.find((x) => x.id === id); return c ? `${c.rank}${SUIT_SYM[c.suit]}` : id; }

function toggleSelect(id) { if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id); pendingLayoff = null; render(); }

function updateActionButtons() {
  const me = state.players.find((p) => p.id === myId);
  const myTurn = isMyTurn();
  const meldPhase = myTurn && state.turnPhase === 'meld';
  document.getElementById('btn-meld').disabled = !(meldPhase && selectedIds.size >= 3);
  document.getElementById('btn-layoff').disabled = !(meldPhase && selectedIds.size === 1 && state.melds.length > 0 && me?.hasMelded);
  document.getElementById('btn-discard').disabled = !(meldPhase && selectedIds.size === 1 && (state.mustMeldCardIds || []).length === 0);
}

function renderCardMini(card, headId, ownerId) {
  const red = SUIT_RED.has(card.suit) ? ' red' : '';
  const speto = SPETO_IDS.has(card.id) ? ' speto' : '';
  const head = card.id === headId ? ' head-mark' : '';
  const ownerInitial = ownerId ? (state.players.find((p) => p.id === ownerId)?.name?.[0] || '') : '';
  return `<div class="card mini${red}${speto}${head}" title="${ownerInitial ? 'โดย ' + ownerInitial : ''}"><div class="top">${card.rank}${SUIT_SYM[card.suit]}</div><div class="bot">${SUIT_SYM[card.suit]}${card.rank}</div></div>`;
}

function renderScores() {
  const c = document.getElementById('scores');
  const rows = state.players.map((p) => `
    <tr class="${p.isCurrent ? 'current' : ''}">
      <td>${escapeHtml(p.name)}${p.id === myId ? ' (คุณ)' : ''}</td>
      <td>${p.totalScore}</td>
    </tr>`).join('');
  c.innerHTML = `<b>คะแนนสะสม</b>
    <table><thead><tr><th>ผู้เล่น</th><th>รวม</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderLog() {
  const c = document.getElementById('log');
  c.innerHTML = '<b>บันทึกเกม</b>' + (state.log || []).slice().reverse().map((l) => `<div class="line">${escapeHtml(l.msg)}</div>`).join('');
}

function renderRoundEnd() {
  const modal = document.getElementById('round-modal');
  if (state.turnPhase !== 'roundEnd' || !state.lastRoundScores) { modal.classList.add('hidden'); return; }
  const sorted = [...state.lastRoundScores].sort((a,b) => b.net - a.net);
  const maxNet = sorted[0]?.net ?? 0;
  const knockLabel = { normal: 'น็อก', blind: 'น็อกมืด', color: 'น็อกสี', blindColor: 'น็อกมืดสี' };
  const penLabel = { tingMee: 'ทิ้งมี่', piHua: 'ปี้หัว', tem: 'ทิ้งเต็ม', spetoLayoff: 'ถูกฝากสเปโต', stupid: 'ทิ้งโง่' };
  document.getElementById('round-title').textContent = `จบรอบที่ ${state.roundNumber}`;
  const rows = sorted.map((s) => {
    const penDesc = s.penaltyEvents.length ? s.penaltyEvents.map((e) => penLabel[e.type] || e.type).join(', ') : '—';
    const bonusDesc = s.knockType ? `${knockLabel[s.knockType]} +${s.knockBonus}${s.multiplier > 1 ? ` ×${s.multiplier}` : ''}` : '';
    const dark = s.darkNegative ? '<span style="color:#ff8080">ลบมืด ×(−2)</span>' : '';
    return `<tr class="${s.net === maxNet ? 'winner' : ''}"><td>${escapeHtml(s.name)}</td><td>${s.meldPts}</td><td>${bonusDesc || '—'}</td><td>${penDesc} (${-s.penaltyPts})</td><td>${dark}</td><td><b>${s.net >= 0 ? '+' : ''}${s.net}</b></td></tr>`;
  }).join('');
  document.getElementById('round-scores').innerHTML = `<table>
    <thead><tr><th>ผู้เล่น</th><th>แต้มไพ่</th><th>โบนัสน็อก</th><th>ลบ</th><th>พิเศษ</th><th>รวม</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  modal.classList.remove('hidden');
  const btn = document.getElementById('btn-next-round');
  btn.style.display = (myId === hostId) ? '' : 'none';
}

// ---- utility ----
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#b71c1c;color:#fff;padding:0.5em 1em;border-radius:4px;z-index:200';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ---- sockets ----
socket.on('connect', () => { myId = socket.id; render(); });
socket.on('state', ({ roomCode: rc, hostId: hi, state: s }) => { roomCode = rc; hostId = hi; state = s; render(); });
socket.on('disconnect', () => toast('ขาดการเชื่อมต่อ'));
