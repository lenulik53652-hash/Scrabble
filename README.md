# Slovenský Scrabble

A responsive Slovak Scrabble game for 2–4 players. A lobby starts with two seats; a joined player can add seats up to the four-player maximum before the game starts. Each player joins from their own device with **＋ Pridať sa** and enters their name. Once every opened seat is claimed, a player presses **Začať hru** to deal the racks. A seat is bound to a private device token; changing the URL cannot switch to another player's rack. The Slovak tile bag intentionally excludes Q and W.

## Play online

Deploy this repository as a Render Blueprint using `render.yaml`. Render gives you a public URL; send that link to everyone playing. Each person opens it, chooses their seat, and the board synchronizes automatically while the game is open.

Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in the Render service's **Environment** settings. In Turso, open your database's connection details and copy its `libsql://...` URL; create a database auth token and add it to Render as `TURSO_AUTH_TOKEN`. Keep the token private, then redeploy. The server creates its game-state table automatically and `/api/storage` reports whether cloud saves are connected. If the database is empty, an existing local `data/state.json` is copied into it on startup.

When either Turso setting is missing or the database is unreachable, the game continues with a local JSON backup. On Render's free plan that local file is temporary and may be lost after a restart, so confirm that `/api/storage` reports `"provider":"turso"` and `"connected":true` before relying on cloud saves.

## Run locally

Requires Node.js. From this project directory, run:

```sh
npm start
```

Then open http://localhost:3000. Without Turso environment variables, the server stores the current game in `data/state.json`; that runtime file is intentionally excluded from Git. For local cloud-save testing, create a private `.env` with the two Turso settings before starting the server.

## Dictionary

The game uses the word list in `data/words.txt`. To rebuild it from the included dictionary sources, run `npm run build-dict`.