#!/usr/bin/env python3
"""Backfill race exports newest-to-oldest, skipping races already in data/.

Caps the number of exports per run (--max) so a single dispatch stays
well inside free GitHub Actions limits and FastF1 rate limits.
"""
import argparse, json, os, subprocess, sys
import fastf1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from-year', type=int, required=True)
    ap.add_argument('--to-year', type=int, required=True)
    ap.add_argument('--max', type=int, default=6)
    args = ap.parse_args()

    os.makedirs('/tmp/ff1cache', exist_ok=True)
    fastf1.Cache.enable_cache('/tmp/ff1cache')

    existing = {f[:-5] for f in os.listdir('data') if f.endswith('.json') and f != 'races.json'}
    queue = []  # (year, gp_name, slug) newest first
    for year in range(args.from_year, args.to_year - 1, -1):
        try:
            sched = fastf1.get_event_schedule(year)
        except Exception as e:
            print(f'schedule {year} failed: {e}', flush=True)
            continue
        rounds = [(r, ev) for r, ev in zip(sched['RoundNumber'], sched['EventName'])]
        for rnd, name in sorted(rounds, key=lambda t: -t[0]):
            slug = f"{year}-" + name.lower().replace('grand prix', '').strip() \
                         .replace(' ', '-').replace('ã', 'a').replace('é', 'e').replace('ü', 'u').strip('-')
            if slug not in existing:
                queue.append((year, name.replace(' Grand Prix', ''), slug))

    print(f'{len(queue)} races missing; exporting up to {args.max}', flush=True)
    done = 0
    for year, gp, slug in queue[: args.max]:
        print(f'=== {slug} ({gp}) ===', flush=True)
        rc = subprocess.call([sys.executable, 'export_race.py', '--year', str(year),
                              '--gp', gp, '--id', slug, '--tag', slug.split("-", 1)[1].upper().replace('-', ''),
                              '--out', f'data/{slug}.json', '--retries', '6'])
        if rc == 0 and os.path.exists(f'data/{slug}.json'):
            done += 1
        else:
            print(f'skip {slug} (export failed, will be retried on the next run)', flush=True)
    print(f'exported {done} race(s)', flush=True)

if __name__ == '__main__':
    main()
