# Dummy Online

Real-time multiplayer Thai Dummy card game (2–4 players) implemented per `dummy_game_spec.md`.

## Features
- Sets (ตอง) and runs (เรียง), lay-off onto existing melds
- Draw from stock, from discard top, or pull the **head** card (+50 bonus if used)
- Out-of-turn **SPETO** with a 6-second timed window
- **Stupid discard** auto-detected (–50)
- **Knock planner**: place all cards into melds/layoffs/face-down layoffs (+50 each) and discard the last card
- Full round scoring, cumulative totals, configurable target score
- Ace-wraps-around-King option (Q-K-A)

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```

Two-player quick test: open the URL in two browsers (or one normal + one incognito), create a room in the first, share the 5-letter code, join in the second, then click **Start Game**.

## Deploy

### Option A — Render (easiest, free tier)
1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), create a new **Web Service** from the repo.
3. Render will auto-detect `render.yaml`. Confirm and deploy.
4. Share the resulting `https://<name>.onrender.com` URL with your friends.

### Option B — Railway
1. Push to GitHub.
2. Create a new project on [railway.app](https://railway.app) from the repo.
3. Railway auto-detects Node. Add the default **web** service with start command `node server.js` (also in `Procfile`).
4. Set `PORT` (Railway does this automatically). Deploy.

### Option C — Fly.io
```bash
fly launch  # accept the defaults; internal_port = 3000
fly deploy
```

## How to play (quick)
- Each turn: **Draw** (stock, discard, or head) → optionally **Meld** / **Lay off** → **Discard** to end.
- Cards drawn from the discard pile or head **must be used** in a meld/layoff that same turn.
- Click cards in your hand to select them, then click **Meld** (3+ selected) or **Lay Off** (1 selected + click a table meld).
- Click **Knock…** to open the planner and end the round by clearing your hand.
- If someone discards a card that completes a meld with 2 of your cards, a **SPETO** modal pops up — grab it before the timer runs out.

## Scoring
- Cards left in hand at knock: `A=15, 2–9=5, 10/J/Q/K=10` (subtracted)
- +50 each for: knock, speto, head-take, face-down layoff
- –50 each: stupid discard (auto-detected)
- First to reach the target score wins the game.

## Files
```
server.js              # Express + Socket.IO server
src/rooms.js           # In-memory room store
src/game/cards.js      # Deck, points, shuffle
src/game/melds.js      # Set/run validation, layoff logic
src/game/stupid.js     # Stupid-discard detection
src/game/scoring.js    # Round scoring
src/game/game.js       # Full GameState + turn/action flow
public/index.html      # Client shell
public/style.css       # UI
public/client.js       # Client logic
```
