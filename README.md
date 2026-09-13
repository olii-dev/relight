# RELIGHT - Historic F1 Race Replay

**Live: [relight.mebbo.cloud](https://relight.mebbo.cloud)**

Pick a Grand Prix from history and watch it unfold like a live broadcast: an animated
timing tower with real gaps, tyre compounds and wear, pit stops, DRS, safety car and
red flag states, race control messages, every car moving on the circuit map, and full
car telemetry - all driven by real timing data.

## The race library

Bundled races (2018+ era, full telemetry):

- **2021 Abu Dhabi GP** - THE LAST LAP. The title decider, lap 58.
- **2021 British GP** - Copse. 51G. Comeback.
- **2021 Brazilian GP** - Hamilton P10 to P1.
- **2021 Italian GP** - Title rivals collide at Monza.
- **2022 Sao Paulo GP** - Russell's maiden win and a Merc 1-2.
- **2023 Singapore GP** - Four-way finale.
- **2024 Sao Paulo GP** - Verstappen P17 to P1 in the rain.
- **2025 British GP** - Wet race masterclass.

## Features

- **Live-style replay** - timing tower, gaps, intervals, tyre wear rings, pit badges,
  DRS highlighting, safety car / VSC / red flag banners, race control ticker, chequered
  flag podium. Gaps are computed from true track position, so mid-lap passes show
  honestly (the chasing car's gap ticks down through zero and inverts).
- **Battle mode** - lock any two drivers: live gap, DRS range flag, tyre offset,
  pit-lane loss estimate, undercut/overcut threat, and a gap-over-race chart.
- **Telemetry duel** - two drivers' speed traces overlaid on the current lap, with
  live speed, gear, RPM, throttle, brake and DRS channels, and the track map colored
  by minisector advantage.
- **Driver telemetry** - one driver's full lap trace, corner-by-corner, synced to
  their dot on the track, with previous-lap ghost comparison.
- **Shareable moments** - the URL always encodes the race, exact moment, speed,
  focused driver and battle pair. Copy the link and someone else opens that exact scene.
- **Race picker** - a library of historic races; any FastF1 race from 2018 on can be added.

## Controls

- Play/pause: button or `Space`. Speeds 1x-60x. Arrows skip 10s, `R` restarts.
- `B` battle mode, `T` telemetry. Click a tower row to follow a driver.
- Scrub the timeline or jump with the moment chips (lead changes, safety cars,
  fastest lap, final lap, chequered flag).

## Adding more races (any FastF1 race, 2018+)

Relight is not a fixed set of races - any Formula 1 race from 2018 onward can be
exported from the official timing data via [FastF1](https://github.com/theOehrly/FastF1)
and added to the picker without touching the app code.

**Batch backfill (recommended):** Actions -> "Backfill races" -> Run workflow.
Pick a year range (newest to oldest, e.g. 2026 down to 2021) and a per-run cap
(default 6 races). The workflow skips races already exported, runs
newest-to-oldest, commits the new data files, and rebuilds the picker manifest.
Re-run it to keep going backwards through history.

**Single race:** Actions -> "Export race" -> Run workflow with a year and GP name.

**Locally:**
    pip install fastf1
    python3 export_race.py --year 2024 --gp "Monza" --id 2024-italian --tag ITALIAN --out data/2024-italian.json
    python3 build_manifest.py

Each race adds one ~3-4 MB JSON file under `data/`. Everything is served as
static files from GitHub Pages; there is no server and no storage service.
GitHub Actions is free for public repositories, and a full season of races is
~80 MB - far inside GitHub's recommended repo and Pages limits. Note F1's
timing API rate-limits exports, so large backfills are spread over multiple runs.



Data comes from [FastF1](https://github.com/theOehrly/Fast-F1), which reads the
official Formula 1 live timing data (full position and timing data from 2018 on).

**Easiest way - GitHub Action:** repo Actions tab -> "Export race" -> Run workflow ->
enter year, Grand Prix name, an id and a tagline. The workflow exports the session,
rebuilds the library manifest, and commits the new data. The site updates itself.

**Locally:**

```bash
pip install -r requirements.txt
python3 export_race.py --year 2023 --gp "Monza" --id 2023-italian --tag "YOUR TAGLINE" --out data/2023-italian.json
python3 build_manifest.py
```

Commit the new `data/*.json` and `data/races.json`.

## Run it yourself

Static site - serve this folder with anything:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## How it works

- `export_race.py` pulls a race session with FastF1 (lap timing, positions, track
  status, race control messages, car position traces and speed/throttle/brake/gear/RPM/DRS
  telemetry) and compacts it into one JSON file per race.
- `build_manifest.py` scans `data/` and writes `data/races.json`, the library index
  the picker reads.
- `app.js` reconstructs the full race state for any moment in time. Every car sample
  is projected onto the circuit polyline, so gaps and intervals come from true race
  distance - positions still update officially at the timing line, exactly like the
  real broadcast - and renders at 60fps on canvas.

Data (c) Formula 1, accessed via the unofficial FastF1 library. Personal,
non-commercial use only.

## Ideas on the roadmap

- Strategy ghost: where a driver would have rejoined on a different pit lap
- Story mode: auto-guided tour through the moments that decided the race
- Spoiler-free mode: hide the winner until the replay reaches the flag
- Season mode: linked replays across a championship
