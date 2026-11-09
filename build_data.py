#!/usr/bin/env python3
"""Build dataset.json for the Deep Bench demo from nflverse weekly rosters."""
import csv, json, os, sys, re
from collections import defaultdict, Counter

DATA = os.path.join(os.path.dirname(__file__), "data")
OUT = os.path.join(os.path.dirname(__file__), "public", "dataset.json")

# Position normalization -> canonical groups
POS_MAP = {
    "QB": "QB", "RB": "RB", "FB": "FB", "HB": "RB", "WR": "WR", "TE": "TE",
    "T": "OL", "G": "OL", "C": "OL", "OL": "OL", "OT": "OL", "OG": "OL", "OC": "OL", "SA": "OL",
    "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL", "E": "DL",
    "LB": "LB", "ILB": "LB", "MLB": "LB", "OLB": "LB", "EDGE": "DL", "BL": "LB",
    "CB": "CB", "S": "S", "FS": "S", "SS": "S", "DB": "S", "SAF": "S", "RC": "CB", "LC": "CB",
    "K": "K", "P": "P", "LS": "LS", "H": "K", "KR": "WR", "PR": "WR",
}
TEAM_NAMES = {
    "ARI": "Cardinals", "ATL": "Falcons", "BAL": "Ravens", "BUF": "Bills",
    "CAR": "Panthers", "CHI": "Bears", "CIN": "Bengals", "CLE": "Browns",
    "DAL": "Cowboys", "DEN": "Broncos", "DET": "Lions", "GB": "Packers",
    "HOU": "Texans", "IND": "Colts", "JAX": "Jaguars", "JAC": "Jaguars",
    "KC": "Chiefs", "LAC": "Chargers", "SD": "Chargers", "OAK": "Raiders",
    "LV": "Raiders", "LAR": "Rams", "STL": "Rams", "LA": "Rams",
    "MIA": "Dolphins", "MIN": "Vikings", "NE": "Patriots", "NO": "Saints",
    "NYG": "Giants", "NYJ": "Jets", "PHI": "Eagles", "PIT": "Steelers",
    "SEA": "Seahawks", "SF": "49ers", "TB": "Buccaneers", "TEN": "Titans",
    "WSH": "Commanders", "WAS": "Commanders",
}
# Canonical franchise codes (merge relocations/renames)
CODE_MAP = {
    "SD": "LAC", "OAK": "LV", "STL": "LAR", "LA": "LAR", "JAC": "JAX", "WAS": "WSH",
    "ARZ": "ARI", "BLT": "BAL", "CLV": "CLE", "HST": "HOU", "SL": "LAR",
}

def canon_pos(p):
    if not p: return None
    p = p.strip().upper()
    return POS_MAP.get(p)

def main():
    # player key -> aggregated record
    players = {}
    # (team, canon_pos) -> {player_key: set(seasons)}
    team_pos = defaultdict(lambda: defaultdict(set))
    # (team, number) -> {player_key: set(seasons)}
    team_num = defaultdict(lambda: defaultdict(set))
    # (player, team, season) -> Counter(position), Counter(number)
    ts_pos = defaultdict(Counter)
    ts_num = defaultdict(Counter)
    seasons_seen = set()

    files = sorted(f for f in os.listdir(DATA) if f.startswith("roster_weekly_") and f.endswith(".csv"))
    if not files:
        sys.exit("No roster CSVs found in data/")
    for fn in files:
        path = os.path.join(DATA, fn)
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            for row in csv.DictReader(f):
                name = (row.get("full_name") or "").strip()
                if not name: continue
                season = row.get("season"); team = row.get("team")
                if not season or not team: continue
                team = CODE_MAP.get(team.strip().upper(), team.strip().upper())
                if team not in TEAM_NAMES: continue
                # keep only players who were on the active roster (incl. gameday
                # inactive / reserve) — drops practice squad & offseason cuts
                if (row.get("status") or "").strip().upper() not in {"ACT", "INA", "RES"}:
                    continue
                key = row.get("gsis_id") or row.get("pfr_id") or f"n|{name.lower()}|{row.get('birth_date','')}"
                season = int(season)
                seasons_seen.add(season)
                p = players.get(key)
                if p is None:
                    p = players[key] = {
                        "name": name,
                        "teams": defaultdict(set),        # team -> seasons
                        "pos": defaultdict(Counter),      # team -> season -> Counter(canonical pos)
                        "num": defaultdict(Counter),      # team -> season -> Counter(number)
                        "draft_number": None, "rookie_year": None,
                    }
                p["teams"][team].add(season)
                num = (row.get("jersey_number") or "").strip()
                cpos = canon_pos(row.get("position"))
                if cpos:
                    ts_pos[(key, team, season)][cpos] += 1
                    team_pos[(team, cpos)][key].add(season)
                if num and num.isdigit():
                    n = int(num)
                    if 1 <= n <= 99:
                        ts_num[(key, team, season)][n] += 1
                        team_num[(team, n)][key].add(season)
                dn = (row.get("draft_number") or "").strip()
                if dn.isdigit() and p["draft_number"] is None:
                    p["draft_number"] = int(dn)
                ry = (row.get("rookie_year") or "").strip()
                if ry.isdigit() and p["rookie_year"] is None:
                    p["rookie_year"] = int(ry)

    # Finalize players
    out_players = {}
    for key, p in players.items():
        teams = {}
        for team, seasons in p["teams"].items():
            seas = sorted(seasons)
            # dominant canonical position for this team-stint
            pos_counts = Counter()
            for s in seas:
                pos_counts.update(ts_pos.get((key, team, s), {}))
            num_counts = Counter()
            for s in seas:
                num_counts.update(ts_num.get((key, team, s), {}))
            teams[team] = {
                "seasons": seas,
                "pos": pos_counts.most_common(1)[0][0] if pos_counts else None,
                "number": num_counts.most_common(1)[0][0] if num_counts else None,
            }
        n_seasons = len(set().union(*[set(t["seasons"]) for t in teams.values()])) if teams else 0
        fame = n_seasons
        dn = p["draft_number"]
        if dn is not None:
            if dn <= 32: fame += 12
            elif dn <= 64: fame += 8
            elif dn <= 100: fame += 4
        if p["rookie_year"] and p["rookie_year"] < 2004: fame += 2
        out_players[key] = {
            "name": p["name"],
            "teams": {t: {"n": len(v["seasons"]), "first": min(v["seasons"]), "last": max(v["seasons"]),
                          "pos": v["pos"], "number": v["number"]} for t, v in teams.items()},
            "n_seasons": n_seasons,
            "fame": fame,
        }

    # team+position index (all-time, 2002+)
    idx_pos = {}
    for (team, pos), pk in team_pos.items():
        if len(pk) < 2: continue
        idx_pos.setdefault(team, {})[pos] = sorted(pk)
    # team+number index (keep singletons for the lookup bench; question gen filters >=2)
    idx_num = {}
    for (team, num), pk in team_num.items():
        idx_num.setdefault(team, {})[str(num)] = sorted(pk)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    data = {
        "coverage": f"{min(seasons_seen)}-{max(seasons_seen)}",
        "teams": TEAM_NAMES,
        "players": out_players,
        "team_pos": idx_pos,
        "team_num": idx_num,
    }
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print(f"players: {len(out_players)}")
    print(f"team+position groups: {sum(len(v) for v in idx_pos.values())}")
    print(f"team+number groups: {sum(len(v) for v in idx_num.values())}")
    multi = sum(1 for p in out_players.values() if len(p['teams']) >= 2)
    print(f"multi-team players: {multi}")
    print(f"size: {os.path.getsize(OUT)/1e6:.1f} MB")

if __name__ == "__main__":
    main()
