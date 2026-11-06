# Matchday 26/27 — Football Calendar

An interactive calendar of every 2026/27 **Premier League**, **LaLiga** and **Bundesliga** match — fixtures, live scores and results.

- The hero shows the next kick-off (or a live match) with a countdown and the next five games.
- Cards show the stadium photo, both club crests, the score with the winner highlighted, goal scorers and booking counts.
- The match drawer shows Player of the Match, goals with assists, bookings, a timeline, team stats, line-ups and the ESPN report. For upcoming games it shows each side's form and last five results.
- Filters: league, fixtures/results, team, month and "jump to today".

## Run locally

It's a static site with no build step. Serve the folder with any static server, e.g.:

```bash
uv run --no-project python -m http.server 5173
```

Then open http://localhost:5173.

## Deploy

Push the folder to a GitHub repo and turn on GitHub Pages (Settings → Pages → deploy from branch, root).

## Data

- Fixtures, results and match details come from ESPN's public site API (`site.api.espn.com`), fetched in the browser. The app polls live matches every 60 seconds.
- Stadium photos are from Wikimedia Commons (`js/venues.js`, keyed by ESPN venue id).
- **Player of the Match is not an official award.** It's a rating calculated from each player's match stats: goals, assists, shots, saves, clean sheets and cards. ESPN doesn't publish an official one.
- Bump the `?v=` numbers in `index.html` after editing CSS/JS so browsers fetch the new files.
