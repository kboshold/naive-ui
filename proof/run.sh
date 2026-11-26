#!/usr/bin/env bash
# Checks that every native attr a component is typed with behaves like on a
# native element. Has to live in a folder directly inside the naive-ui checkout.
#   bash proof/run.sh                    all stages
#   bash proof/run.sh keys               types -> list of attrs per component
#   bash proof/run.sh jsdom              runtime checks in jsdom
#   bash proof/run.sh browser <engine>   runtime checks in chromium, firefox or webkit
#   bash proof/run.sh check              type checks, report, verdict
# PROOF_BROWSERS    engines for "all", default "chromium", empty for jsdom only
# PROOF_EXECUTABLE  browser binary, if Playwright's own one should not be used
# PROOF_OUT         absolute output folder, default <this folder>/out
set -euo pipefail
stage=${1:-all}
dir=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$dir/.." && pwd)
out=${PROOF_OUT:-$dir/out}
work=$repo/src/__proof__
config=$repo/vitest.proof.config.mts
browsers=${PROOF_BROWSERS-chromium}

if [ ! -f "$repo/src/index.ts" ]; then
  echo "put this folder directly into the naive-ui checkout" >&2
  exit 2
fi

cleanup() {
  rm -rf "$work" "$config" "$repo/.proof-browser"
}
trap cleanup EXIT

mkdir -p "$out" "$work"
cp "$dir/proof.shared.ts" "$work/"
cat > "$work/entry.ts" <<'EOF'
import type { IntrinsicElementAttributes } from 'vue'
import type * as N from '../index'

export type Components = typeof N
export type Elements = IntrinsicElementAttributes
EOF
export VITE_CONFIG_NATIVE_IGNORE_WARNING=true
export TZ=Asia/Shanghai
cd "$repo"

keys() {
  node "$dir/types.mjs" keys "$out/keys.json"
}

need_keys() {
  [ -f "$out/keys.json" ] || keys
  cp "$out/keys.json" "$work/keys.json"
}

jsdom() {
  need_keys
  rm -rf "$out/runtime-jsdom"
  mkdir -p "$out/runtime-jsdom"
  # One file per shard, so each worker only holds a part of the components
  for shard in 0 1 2 3 4 5 6 7; do
    cat > "$work/proof-node-$shard.spec.ts" <<EOF
import { writeFileSync } from 'node:fs'
import { run } from './proof.shared'

run($shard, 8, (name, content) =>
  writeFileSync(\`\${process.env.PROOF_RUNTIME}/\${name}.json\`, content))
EOF
  done
  echo "jsdom ..."
  PROOF_RUNTIME=$out/runtime-jsdom pnpm exec vitest run src/__proof__/proof-node- \
    --dangerouslyIgnoreUnhandledErrors > "$out/jsdom.log" 2>&1 || true
  rm -f "$work"/proof-node-*.spec.ts
  echo "jsdom: $(find "$out/runtime-jsdom" -name '*.json' | wc -l) components"
}

browser() {
  local engine=$1
  need_keys
  rm -rf "$out/runtime-$engine" "$repo/.proof-browser"
  mkdir -p "$out/runtime-$engine"
  cat > "$work/proof.browser.spec.ts" <<'EOF'
import { commands } from 'vitest/browser'
import { run } from './proof.shared'

run(0, 1, (name, content) =>
  commands.writeFile(`./.proof-browser/${name}.json`, content))
EOF
  cat > "$config" <<'EOF'
import { playwright } from '@vitest/browser-playwright'
import base from './vitest.browser.config.mts'

const executablePath = process.env.PROOF_EXECUTABLE || undefined

export default {
  ...base,
  test: {
    ...base.test,
    testTimeout: 900_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { executablePath } }),
      instances: [{ browser: process.env.PROOF_ENGINE }]
    }
  }
}
EOF
  echo "$engine ..."
  PROOF_ENGINE=$engine pnpm exec vitest run --config "$config" \
    src/__proof__/proof.browser.spec.ts > "$out/$engine.log" 2>&1 || true
  if [ -d "$repo/.proof-browser" ]; then
    cp "$repo"/.proof-browser/*.json "$out/runtime-$engine/"
  fi
  rm -rf "$repo/.proof-browser" "$work/proof.browser.spec.ts" "$config"
  echo "$engine: $(find "$out/runtime-$engine" -name '*.json' | wc -l) components"
}

check() {
  need_keys
  node "$dir/report.mjs" summary "$out"
  node "$dir/types.mjs" verify "$out/keys.json" "$out/summary.json" "$out/types.json" > "$out/types.log"
  node "$dir/template.mjs" "$out/keys.json" "$out/summary.json" "$work/Proof.vue" "$out/template-map.json"
  cat > "$work/tsconfig.json" <<'EOF'
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "composite": false,
    "declaration": false,
    "incremental": false,
    "noEmit": true,
    "rootDir": "../.."
  },
  "vueCompilerOptions": { "strictTemplates": true },
  "include": ["./Proof.vue", "../global.d.ts"]
}
EOF
  echo "strict template ..."
  NODE_OPTIONS=--max-old-space-size=4096 pnpm exec vue-tsc -p "$work/tsconfig.json" \
    > "$out/template.log" 2>&1 || true
  # The template has one error on purpose, an empty log means vue-tsc did not run
  [ -s "$out/template.log" ] || echo "vue-tsc printed nothing" > "$out/template.log"
  cp "$work/Proof.vue" "$out/Proof.vue"
  node "$dir/report.mjs" report "$out"
}

case $stage in
  keys) keys ;;
  jsdom) jsdom ;;
  browser) browser "$2" ;;
  check) check ;;
  all)
    rm -rf "$out"/runtime-*
    keys
    jsdom
    for engine in $browsers; do
      browser "$engine"
    done
    check
    ;;
  *)
    echo "unknown stage $stage" >&2
    exit 2
    ;;
esac
