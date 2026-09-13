"""Export a FastF1 race session to a compact JSON file for RELIGHT (schema v2).

v2 merges car telemetry (speed, throttle, brake, gear, rpm, DRS) into the
position trace so the app can render live telemetry without extra requests.

Usage:
    python3 export_race.py --year 2021 --gp "Abu Dhabi" --id 2021-abu-dhabi \
        --tag "THE LAST LAP" --out data/2021-abu-dhabi.json
"""
import argparse, json, math, os, sys, time
import fastf1
import pandas as pd

def td_s(x):
    if x is None or (isinstance(x, float) and math.isnan(x)) or pd.isna(x):
        return None
    return round(x.total_seconds(), 3)

def ts_s(x, t0):
    if x is None or pd.isna(x):
        return None
    if hasattr(x, 'total_seconds'):
        return round(x.total_seconds(), 3)
    return round((x - t0).total_seconds(), 3)

def export(year, gp, race_id, tag, out, with_telemetry=True):
    s = fastf1.get_session(year, gp, 'R')
    s.load(telemetry=True, weather=False, messages=True)

    drivers = []
    for _, r in s.results.iterrows():
        drivers.append({
            'number': str(r['DriverNumber']),
            'code': r['Abbreviation'],
            'name': r['FullName'],
            'team': r['TeamName'],
            'color': '#' + str(r['TeamColor']),
            'grid': None if pd.isna(r['GridPosition']) else int(r['GridPosition']),
            'finalPosition': None if pd.isna(r['Position']) else int(r['Position']),
            'finalStatus': r['Status'],
            'points': float(r['Points']),
        })

    laps = []
    for _, l in s.laps.iterrows():
        secs = []
        for c in ('Sector1Time', 'Sector2Time', 'Sector3Time'):
            secs.append(td_s(l.get(c)))
        laps.append({
            'driver': str(l['DriverNumber']),
            'lap': int(l['LapNumber']),
            'lapStart': td_s(l['LapStartTime']),
            'time': td_s(l['LapTime']),
            'lapEnd': td_s(l['Time']),
            'position': None if pd.isna(l['Position']) else int(l['Position']),
            'stint': None if pd.isna(l['Stint']) else int(l['Stint']),
            'compound': None if pd.isna(l['Compound']) else str(l['Compound']),
            'tyreLife': None if pd.isna(l['TyreLife']) else int(l['TyreLife']),
            'pitIn': td_s(l['PitInTime']),
            'pitOut': td_s(l['PitOutTime']),
            'trackStatus': str(l['TrackStatus']),
            'personalBest': bool(l['IsPersonalBest']) if not pd.isna(l['IsPersonalBest']) else False,
            'sectors': secs,
        })

    track_status = [{'time': td_s(r['Time']), 'status': str(r['Status']), 'message': str(r['Message'])}
                    for _, r in s.track_status.iterrows()]

    t0 = s.t0_date
    msgs = []
    for _, m in s.race_control_messages.iterrows():
        msgs.append({
            'time': ts_s(m['Time'], t0),
            'category': str(m.get('Category', '')),
            'message': str(m.get('Message', '')),
            'flag': None if pd.isna(m.get('Flag')) else str(m.get('Flag')),
        })

    # track outline from a clean mid-race lap of the winner
    ref = str(s.results.iloc[0]['DriverNumber'])
    pd_ref = s.pos_data[ref]
    rlaps = s.laps[s.laps['DriverNumber'] == ref]
    mid = rlaps[(rlaps['LapTime'].notna()) & (rlaps['TrackStatus'] == '1')]
    lap_row = mid.iloc[len(mid)//2]
    lt0, lt1 = lap_row['LapStartTime'], lap_row['LapStartTime'] + lap_row['LapTime']
    seg = pd_ref[(pd_ref['Time'] >= lt0) & (pd_ref['Time'] <= lt1)]
    step = max(1, len(seg)//400)
    track = [[int(x), int(y)] for x, y in zip(seg['X'].iloc[::step], seg['Y'].iloc[::step])]

    # merged car traces: position + telemetry, downsampled to every ~2 s
    cars = {}
    have_tel = 0
    for num, d in s.pos_data.items():
        d = d[d['Status'] == 'OnTrack']
        if len(d) == 0:
            continue
        tel = None
        if with_telemetry and num in s.car_data:
            t = s.car_data[num]
            if len(t):
                tel = t[['Time', 'Speed', 'RPM', 'nGear', 'Throttle', 'Brake', 'DRS']].copy()
                have_tel += 1
        if tel is not None:
            m = pd.merge_asof(d.sort_values('Time'), tel.sort_values('Time'),
                              on='Time', tolerance=pd.Timedelta('1.5s'))
        else:
            m = d.sort_values('Time')
        t0s = m['Time'].dt.total_seconds().values
        keep = [0]
        last = t0s[0]
        for i in range(1, len(m)):
            if t0s[i] - last >= 2.0:
                keep.append(i); last = t0s[i]
        sub = m.iloc[keep]
        rows = []
        for _, r in sub.iterrows():
            row = [round(r['Time'].total_seconds(), 1), int(r['X']), int(r['Y'])]
            if tel is not None:
                def iv(col, default=None):
                    v = r.get(col)
                    return default if v is None or (isinstance(v, float) and math.isnan(v)) or pd.isna(v) else int(v)
                drs = iv('DRS')
                row += [iv('Speed'), iv('Throttle'), (1 if (iv('Brake') or 0) >= 1 else 0 if iv('Brake') is not None else None),
                        iv('nGear'), iv('RPM'), (1 if (drs is not None and drs >= 8) else 0 if drs is not None else None)]
            rows.append(row)
        cars[str(num)] = rows

    total_laps = int(s.total_laps) if s.total_laps is not None else int(s.laps['LapNumber'].max())
    end_time = max(l['lapEnd'] or 0 for l in laps)

    outj = {
        'meta': {
            'id': race_id, 'tag': tag,
            'event': s.event['EventName'], 'location': s.event['Location'],
            'country': s.event['Country'], 'date': str(s.event['EventDate']),
            'year': int(year), 'session': 'Race', 'totalLaps': total_laps,
            'duration': round(end_time, 1), 'schema': 2,
            'telemetry': have_tel >= 15,
            'generatedBy': 'FastF1 ' + fastf1.__version__,
        },
        'drivers': drivers, 'laps': laps, 'trackStatus': track_status,
        'messages': msgs, 'track': track, 'cars': cars,
    }
    with open(out, 'w') as f:
        json.dump(outj, f, separators=(',', ':'))

    assert len(drivers) >= 15, 'few drivers'
    assert sum(1 for l in laps if l['lapEnd'] is not None) > 400, 'few timed laps'
    assert len(cars) >= 15, 'few car traces'
    assert len(track) > 100, 'short track'
    print(f'OK {race_id}: {len(drivers)} drivers, {len(laps)} laps, {len(cars)} traces '
          f'({have_tel} with telemetry), {round(os.path.getsize(out)/1e6,1)}MB', flush=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, required=True)
    ap.add_argument('--gp', required=True)
    ap.add_argument('--id', required=True)
    ap.add_argument('--tag', default='')
    ap.add_argument('--out', required=True)
    ap.add_argument('--retries', type=int, default=6)
    args = ap.parse_args()
    fastf1.Cache.enable_cache('/tmp/ff1cache')
    for attempt in range(1, args.retries + 1):
        try:
            export(args.year, args.gp, args.id, args.tag, args.out)
            return
        except Exception as e:
            print(f'attempt {attempt} failed: {type(e).__name__}: {e}', flush=True)
            if os.path.exists(args.out):
                os.remove(args.out)
            if attempt < args.retries:
                time.sleep(15 + attempt * 10)
    sys.exit(1)

if __name__ == '__main__':
    main()
