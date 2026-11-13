#!/usr/bin/env bash
# Offline preview of the head-unit app: stages it with the vendored kit's build (no BMW SDK, nothing
# installable) and runs it against the kit's stubbed head unit, which saves every frame the app draws
# as a PNG in car/preview/. Nothing is sent anywhere: no head unit, no network.
#
#   car/scripts/preview-car.sh            (the last step of npm run check:car)
#
# Needs python3 and node; exits non-zero when no PNG was drawn.
set -euo pipefail

car_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$car_dir/.." && pwd)"
app_id="p98_copilot"
stage="$car_dir/dist/$app_id"        # car/kit/tools/build.py stages into <kit>/../dist/<id>
out="$car_dir/preview"

rm -rf "$out"
mkdir -p "$out"

# -I: isolated mode (no user site-packages, no PYTHON* variables); build.py finds its own modules.
python3 -I "$car_dir/kit/tools/build.py" --preview-only "$app_id"

# `render` draws one frame of the screen shown (the kit's ctx.loop function for MAIN).
(cd "$out" && node "$car_dir/kit/tools/preview.js" "$stage" "$out" render)

shopt -s nullglob
pngs=("$out"/*.png)
if [ "${#pngs[@]}" -eq 0 ]; then
  echo "preview-car: no PNG was drawn in $out" >&2
  exit 1
fi
echo "preview-car: ${#pngs[@]} PNG(s) in ${out#"$repo_dir/"}:"
for f in "${pngs[@]}"; do echo "  ${f#"$repo_dir/"}"; done
