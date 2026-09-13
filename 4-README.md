# RELIGHT - Historic F1 Race Replay

Pick a Grand Prix from history and watch it unfold like a live broadcast: an animated
timing tower with gaps, intervals and DRS, tyre compounds and wear, pit stops, safety car
and red flag states, race control messages, and every car moving on the circuit map in
real time - all driven by real timing data.

Bundled demo race: **2021 Abu Dhabi Grand Prix** (the last-lap title decider).

## Run it

The app is a static site. Serve this folder with anything:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Controls

- Play / pause with the button or `Space`
- Speeds from 1x to 60x
- Scrub the timeline, or jump straight to the moments that mattered
  (lead changes, safety cars, fastest lap, final lap, chequered flag)
- Click a driver in the tower to follow their car on the map
- Arrow keys skip 10 seconds, `R` restarts

## Replays of any other race

Data comes from [FastF1](https://github.com/theOehrly/Fast-F1), which reads the official
Formula 1 live timing data (2018 onwards has full position and timing data).

```bash
pip install -r requirements.txt
python3 export_race.py --year 2023 --gp "Monza" --out data/race_2023_monza.json
```

Then point the app at the new file by editing `DATA_URL` in `app.js`
(or serve multiple exports and switch between them).

## How it works

- `export_race.py` pulls the session with FastF1 (lap-by-lap timing, positions,
  track status, race control messages, car position traces) and compacts it into one JSON file.
- `app.js` reconstructs the full race state for any moment in time - gaps are interpolated
  between start/finish line crossings, positions update officially at the line - and
  renders the broadcast at up to 60x speed with `requestAnimationFrame`.

Data (c) Formula 1, accessed via the unofficial FastF1 library. For personal,
non-commercial use.
