"""Build data/races.json manifest from exported race files."""
import json, os, glob

races = []
for path in sorted(glob.glob('data/*.json')):
    if path.endswith('races.json'):
        continue
    d = json.load(open(path))
    meta = d['meta']
    by_final = sorted(d['drivers'], key=lambda x: x.get('finalPosition') or 99)
    podium = [{'code': p['code'], 'name': p['name'], 'team': p['team'], 'color': p['color']}
              for p in by_final[:3]]
    track = d['track']
    step = max(1, len(track)//140)
    races.append({
        'id': meta['id'], 'file': path,
        'year': meta['year'], 'event': meta['event'],
        'location': meta['location'], 'country': meta['country'],
        'date': meta['date'], 'totalLaps': meta['totalLaps'],
        'duration': meta['duration'], 'tag': meta.get('tag', ''),
        'telemetry': bool(meta.get('telemetry')),
        'podium': podium, 'track': track[::step],
    })
out = {'schema': 1, 'count': len(races), 'races': races}
with open('data/races.json', 'w') as f:
    json.dump(out, f, separators=(',', ':'))
print(f'manifest: {len(races)} races, {round(os.path.getsize("data/races.json")/1024)}KB')
