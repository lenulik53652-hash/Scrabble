# Slovenský Scrabble

A browser-based Slovak Scrabble game for up to four players, served by a dependency-free Node.js HTTP server.

## Run locally

Requires Node.js. From this project directory, run:

```sh
npm start
```

Then open http://localhost:3000. The server stores the current game in `data/state.json`; that runtime file is intentionally excluded from Git.

## Dictionary

The game uses the word list in `data/words.txt`. To rebuild it from the included dictionary sources, run `npm run build-dict`.