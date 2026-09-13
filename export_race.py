"""Export a FastF1 race session to a compact JSON file for the web replay app."""
import argparse, json, math
import fastf1
import pandas as pd

def td_s(x):
    """timedelta -> seconds float, NaT -> None"""
    if x is None or (isinstance(x, float) and math.isnan(x)) or pd.isna(x):
        return None
    return round(x.total_seconds(), 3)

def ts_s(x, t0):
    """timestamp or timedelta -> session-relative seconds"""
    if x is None or pd.isna(x):
        return None
    if hasattr(x, 'total_seconds'):
        return round(x.total_seconds(), 3)
    return round((x - t0).total_seconds(), 3)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, default=2021)
    ap.add_argument('--gp', default='Abu Dhabi')
    ap.add_argument('--out', default='web/data/race.json')
    args = ap.parse_args()

    fastf1.Cache.enable_cache('/tmp/ff1cache')
    s = fastf1.get_session(args.year, args.gp, 'R')
    s.load(telemetry=True, weather=True, messages=True)
    print('loaded', s.event['EventName'], s.event['EventDate'])

    # ---- drivers ----
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

    # ---- laps ----
    laps = []
    for _, l in s.laps.iterrows():
        laps.append({
            'driver': str(l['DriverNumber']),
            'lap': int(l['LapNumber']),
            'lapStart': td_s(l['LapStartTime']),
            'time': td_s(l['LapTime']),          # duration of the lap
            'lapEnd': td_s(l['Time']),           # session time at line
            'position': None if pd.isna(l['Position']) else int(l['Position']),
            'stint': None if pd.isna(l['Stint']) else int(l['Stint']),
            'compound': None if pd.isna(l['Compound']) else str(l['Compound']),
            'tyreLife': None if pd.isna(l['TyreLife']) else int(l['TyreLife']),
            'pitIn': td_s(l['PitInTime']),
            'pitOut': td_s(l['PitOutTime']),
            'trackStatus': str(l['TrackStatus']),
            'personalBest': bool(l['IsPersonalBest']) if not pd.isna(l['IsPersonalBest']) else False,
        })

    # ---- track status ----
    track_status = [{'time': td_s(r['Time']), 'status': str(r['Status']), 'message': str(r['Message'])}
                    for _, r in s.track_status.iterrows()]

    # ---- race control messages ----
    t0 = s.t0_date
    msgs = []
    for _, m in s.race_control_messages.iterrows():
        msgs.append({
            'time': ts_s(m['Time'], t0),
            'category': str(m.get('Category', '')),
            'message': str(m.get('Message', '')),
            'flag': None if pd.isna(m.get('Flag')) else str(m.get('Flag')),
        })

    # ---- track outline: one clean lap of position data from the polesitter/winner ----
    ref = str(s.results.iloc[0]['DriverNumber'])
    pd_ref = s.pos_data[ref]
    rlaps = s.laps[s.laps['DriverNumber'] == ref]
    # pick a mid-race lap with a valid lap time
    mid = rlaps[(rlaps['LapTime'].notna()) & (rlaps['TrackStatus'] == '1')]
    lap_row = mid.iloc[len(mid)//2]
    t0, t1 = lap_row['LapStartTime'], lap_row['LapStartTime'] + lap_row['LapTime']
    seg = pd_ref[(pd_ref['Time'] >= t0) & (pd_ref['Time'] <= t1)]
    step = max(1, len(seg)//400)
    track = [[int(x), int(y)] for x, y in zip(seg['X'].iloc[::step], seg['Y'].iloc[::step])]

    # ---- position traces, downsampled to every 2.5 s ----
    positions = {}
    for num, d in s.pos_data.items():
        d = d[d['Status'] == 'OnTrack']
        if len(d) == 0:
            continue
        t0s = d['Time'].dt.total_seconds().values
        keep = [0]
        last = t0s[0]
        for i in range(1, len(d)):
            if t0s[i] - last >= 2.5:
                keep.append(i); last = t0s[i]
        sub = d.iloc[keep]
        positions[str(num)] = [[round(t, 1), int(x), int(y)] for t, x, y in
                               zip(sub['Time'].dt.total_seconds(), sub['X'], sub['Y'])]

    total_laps = int(s.total_laps) if s.total_laps is not None else int(s.laps['LapNumber'].max())
    end_time = max(l['lapEnd'] or 0 for l in laps)

    out = {
        'meta': {
            'event': s.event['EventName'],
            'location': s.event['Location'],
            'country': s.event['Country'],
            'date': str(s.event['EventDate']),
            'year': int(args.year),
            'session': 'Race',
            'totalLaps': total_laps,
            'duration': round(end_time, 1),
            'generatedBy': 'FastF1 ' + fastf1.__version__,
        },
        'drivers': drivers,
        'laps': laps,
        'trackStatus': track_status,
        'messages': msgs,
        'track': track,
        'positions': positions,
    }
    with open(args.out, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    import os
    print('wrote', args.out, round(os.path.getsize(args.out)/1e6, 1), 'MB')

if __name__ == '__main__':
    main()
