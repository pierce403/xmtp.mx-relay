#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./genkeys.sh [--json | --env]

Generates a new Ethereum keypair suitable for XMTP (prints address + private key).

Options:
  --json   Output machine-readable JSON only
  --env    Output env var line(s) only (for pasting into .env)
EOF
}

mode="pretty"
if [[ "${1:-}" == "--json" ]]; then
  mode="json"
elif [[ "${1:-}" == "--env" ]]; then
  mode="env"
elif [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
elif [[ "${1:-}" != "" ]]; then
  echo "Unknown argument: ${1}" >&2
  usage >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: node is required (Node.js >= 20)." >&2
  exit 1
fi

if ! node -e "require('ethers')" >/dev/null 2>&1; then
  echo "Error: missing dependency 'ethers'. Run: npm install" >&2
  exit 1
fi

GENKEYS_MODE="$mode" node <<'NODE'
const { Wallet } = require('ethers')

const mode = process.env.GENKEYS_MODE || 'pretty'
const w = Wallet.createRandom()

const out = {
  address: w.address,
  privateKey: w.privateKey,
}

if (mode === 'json') {
  process.stdout.write(JSON.stringify(out))
  process.stdout.write('\n')
  process.exit(0)
}

if (mode === 'env') {
  // Compatible with src/xmtp.ts (accepts 0x-prefixed or raw hex).
  process.stdout.write(`XMTP_BOT_KEY=${out.privateKey}\n`)
  process.exit(0)
}

process.stdout.write('Generated Ethereum keypair for XMTP\n')
process.stdout.write(`Address:    ${out.address}\n`)
process.stdout.write(`PrivateKey: ${out.privateKey}\n`)
process.stdout.write('\nPaste into .env:\n')
process.stdout.write(`XMTP_BOT_KEY=${out.privateKey}\n`)
NODE
