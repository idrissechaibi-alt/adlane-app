#!/usr/bin/env bash
# Copie les données SofaScore utiles à l'app dans $1 (miroir de /api/v1/...).
# Exécuté par GitHub Actions : SofaScore refuse l'IP du téléphone de l'utilisateur
# mais répond aux serveurs GitHub. L'app relit ces fichiers sur la branche sofa-data.
set -u
OUT="${1:-out}"
BASE="https://api.sofascore.com/api/v1"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

grab() { # chemin
  mkdir -p "$OUT/api/v1/$(dirname "$1")"
  local code
  code=$(curl -sS --compressed -m 25 -A "$UA" -o "$OUT/api/v1/$1.tmp" -w '%{http_code}' "$BASE/$1" || echo 000)
  if [ "$code" = "200" ]; then mv "$OUT/api/v1/$1.tmp" "$OUT/api/v1/$1"; else rm -f "$OUT/api/v1/$1.tmp"; echo "HTTP $code pour $1" >&2; fi
  [ "$code" = "200" ]
}

grab "sport/football/events/live" || { echo "SofaScore injoignable depuis ce serveur" >&2; exit 1; }
for d in "$(date -u -d yesterday +%F)" "$(date -u +%F)" "$(date -u -d tomorrow +%F)"; do
  grab "sport/football/scheduled-events/$d" || true
done

# Détail + statistiques des matchs en cours (60 max).
jq -r '.events[:60][] | .id' "$OUT/api/v1/sport/football/events/live" | while read -r id; do
  grab "event/$id" || true
  grab "event/$id/statistics" || true
done

# Matchs terminés dans les 2 dernières heures : détail + stats pour le règlement.
NOW=$(date -u +%s)
for d in "$(date -u -d yesterday +%F)" "$(date -u +%F)"; do
  f="$OUT/api/v1/sport/football/scheduled-events/$d"
  [ -f "$f" ] || continue
  jq -r --argjson now "$NOW" '.events[] | select(.status.type=="finished" and (.startTimestamp // 0) > ($now - 14400)) | .id' "$f" | head -80 | while read -r id; do
    grab "event/$id" || true
    grab "event/$id/statistics" || true
  done
done
date -u +%FT%TZ > "$OUT/updated-at"
echo "OK : $(find "$OUT" -type f | wc -l) fichiers"
