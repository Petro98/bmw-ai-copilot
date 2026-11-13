#!/usr/bin/env bash
# Offline preview of the head-unit app: stages it with the vendored kit's build (no BMW SDK, nothing
# installable) and runs it against the kit's stubbed head unit, which saves every frame the app draws
# as a PNG in car/preview/. Nothing is sent anywhere: no head unit, no network.
#
#   car/scripts/preview-car.sh            (the last step of npm run check:car; run npm run build:car first)
#
# 1. The shipped app (car/apps/p98_copilot/main.js) as the kit stages it: car/preview/main_gfx-0.png.
# 2. The screens (car/src/ui/screen.ts) drawn from a fixture: car/build/preview-entry.js (git-ignored, built
#    by car/scripts/build-car.mjs) in place of the staged app.js, one PNG per screen:
#    car/preview/screen-{assistant-standing,assistant-moving,sensors,alerts,pairing}.png.
#
# Needs python3 and node; exits non-zero when a PNG was not drawn.
set -euo pipefail

car_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_dir="$(cd "$car_dir/.." && pwd)"
app_id="p98_copilot"
stage="$car_dir/dist/$app_id"        # car/kit/tools/build.py stages into <kit>/../dist/<id>
out="$car_dir/preview"
kit_js="$stage/source/javascript/kit"

rm -rf "$out"
mkdir -p "$out"

# -I: isolated mode (no user site-packages, no PYTHON* variables); build.py finds its own modules.
python3 -I "$car_dir/kit/tools/build.py" --preview-only "$app_id"

# The Ukrainian glyph atlas: the staged kit gets it as kit/fonts/cyrillic-uk.json, where the kit's fonts.js
# looks for it (car/kit/VENDORED.md, local edit 5). build.py does not copy kit/localization/fonts/ for an
# English build yet; until it does, the preview puts the atlas in place itself.
if [ ! -f "$kit_js/fonts/cyrillic-uk.json" ]; then
  cp "$car_dir/kit/localization/fonts/cyrillic-uk.json" "$kit_js/fonts/cyrillic-uk.json"
fi

# 1. the shipped app: `render` draws one frame of the screen shown (the kit's ctx.loop function for MAIN)
(cd "$out" && node "$car_dir/kit/tools/preview.js" "$stage" "$out" render)
[ -f "$out/main_gfx-0.png" ] || { echo "preview-car: the app drew no frame" >&2; exit 1; }

# 2. the screens from the fixture: each PREVIEW_* stand-in component switches the fixture, then a frame
screens="$out/screens"
mkdir -p "$screens"
cp "$car_dir/build/preview-entry.js" "$stage/source/javascript/app.js"
(cd "$screens" && node "$car_dir/kit/tools/preview.js" "$stage" "$screens" \
  PREVIEW_STANDING render PREVIEW_MOVING render PREVIEW_SENSORS render PREVIEW_ALERTS render PREVIEW_PAIRING render)
names=(assistant-standing assistant-moving sensors alerts pairing)
for i in "${!names[@]}"; do
  f="$screens/main_gfx-$i.png"
  [ -f "$f" ] || { echo "preview-car: no frame for ${names[$i]}" >&2; exit 1; }
  mv "$f" "$out/screen-${names[$i]}.png"
done
rm -rf "$screens"

shopt -s nullglob
pngs=("$out"/*.png)
echo "preview-car: ${#pngs[@]} PNG(s) in ${out#"$repo_dir/"}:"
for f in "${pngs[@]}"; do echo "  ${f#"$repo_dir/"}"; done
