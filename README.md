# arenalaunch

Launch a pump.fun coin with your whole squad: every person buys from their **own wallet**, in its own transaction, sent together with the coin's create and aimed at the same block. Nobody shares a private key.

Live: https://arenalaunch.bond

## How it works

1. **Lobby.** The dev opens a lobby and shares a 6-letter code. Teammates join with their own wallets and set their own buys.
2. **Rehearse.** A rehearsal builds and signs the whole launch, then stops. It signs against a made-up blockhash, so it can never land.
3. **Launch.** At a shared go-live time the relay sends the dev's create (create_v2 + dev buy, one v0 transaction with a per-launch lookup table) and every squad wallet's buy (buy_exact_quote_in_v2, signed and paid by that wallet) as Jito bundles.

**Enforced, not promised.** The relay re-derives every account of every buy from the new mint and refuses anything that is not exactly this launch, exactly the member's amount, and signed by that member's own wallet. Teammates' browsers independently re-check the launch template before they auto-sign.

**Optional, on chain:** Squad Lock (each wallet's tokens locked on Streamflow right after its buy lands) and creator-fee splitting across the squad via pump.fun's fee-sharing program.

**Fees:** 3% of each launch buy and 2% of private (Husher) transfers go to the treasury, each inside the user's own transaction. The relay refuses buys without the exact fee.

## Layout

| Path | What |
|---|---|
| `site/src/` | the web app (bundled to `site/public/app.js` with `npm run bundle`) |
| `site/src/pump.js` | pump.fun launch builder shared by the app and the tools |
| `site/api/` | Vercel functions: gate, Husher proxy, IPFS upload, RPC proxy |
| `relay/src/` | Cloudflare Worker + Durable Objects: lobbies, transaction validation, launch firing, accounts (Sign In With Solana), stats |
| `site/tools/` | checks and simulations (see below) |

## Run it

```bash
cd site && npm install && npm run bundle
node tools/dev.mjs            # http://localhost:5182 (needs site/.secrets.json: GATE_SECRET, ...)
cd ../relay && npm install && npx wrangler dev   # with DEV=1 in relay/.dev.vars; then RELAY_URL=http://127.0.0.1:8787 node tools/dev.mjs
```

Relay settings: `ALLOWED_ORIGINS` and `ADMIN_WALLET` (the wallet allowed into /stats) in wrangler.jsonc, and secrets `SOL_RPC_URL`, `ACCOUNT_SECRET` (signs sessions, nonces, email codes and password hashes; required), `GATE_SECRET` (the public site gate only), `RL_KEY`, and for email sign-in `RESEND_API_KEY` + `EMAIL_FROM`. `DEV` (local only, never in production) lets localhost origins and sign-in messages through. Without `GATE_SECRET` the relay refuses everything (fails closed).

Private transfers (Husher): the page pays the 2% fee to the treasury first, as its own transaction; `/api/husher` makes the order only after reading that payment on chain (confirmed, under 30 minutes old, enough for the amount) and reserving its signature at the relay's `/fee/claim` (`RL_KEY`), so one payment buys one order. The fee constants live in `site/api/_fees.js`, shared by the page and the function.

Vault keys: a Phantom account's vault key is SHA-256(signature over the fixed unlock message ‖ a per-account pepper). The relay hands the pepper out only with a fresh Sign In With Solana, never with a session alone. Vaults sealed before the pepper are re-sealed on the next sign-in. Across a reload the key is a non-extractable CryptoKey in IndexedDB, not bytes in sessionStorage.

The site's proxies (`/api/sol` on the `SOL_RPC_URL` Helius key, `/api/husher` on `HUSHER_KEY`, `/api/ipfs`, `/api/pump`) answer signed-in users only: the page sends the account session as `x-session`. The site checks it itself with the relay's `ACCOUNT_SECRET` (set on Vercel too), else asks the relay's `/session/check` with `RL_KEY`. It never uses `GATE_SECRET` for sessions.

Email sign-in (code + password) needs two more relay secrets: `RESEND_API_KEY` (resend.com, with your sending domain verified) and `EMAIL_FROM` (e.g. `arenalaunch <login@arenalaunch.bond>`). Without them the email form answers "email sign-in is not set up yet" and nothing else changes. The password is stretched in the browser and never sent; a forgotten password cannot be reset, by anyone, because it also locks the saved wallets.

## Checks

```bash
cd site
node tools/build-sim.mjs relay-check && node tools/.relay-check.bundle.mjs   # relay validation vs. client-built transactions
node tools/build-sim.mjs fee-sim && node tools/.fee-sim.bundle.mjs --coin <mint>   # mainnet simulation of a buy + fee
node tools/lobby-check.mjs     # live lobby rules
node tools/email-check.mjs     # email sign-in rules (offline)
node tools/api-gate-check.mjs  # /api/sol, /api/husher, /api/ipfs, /api/pump answer signed-in users only (offline)
node tools/relay-http-check.mjs   # gate fails closed, origins/CORS, /stats/error rules (offline)
node tools/relay-store-check.mjs  # bounded storage: account summary + pruning, visitor HLL, idle lobbies (offline)
node tools/husher-fee-check.mjs   # the private-transfer fee is enforced by the server, one order per payment (offline)
node tools/vault-pepper-check.mjs # a phished unlock signature + stolen session cannot open a vault (offline)
node tools/build-sim.mjs group-check && node tools/.group-check.bundle.mjs   # dev + 3 teammates rehearsal
```

Keys stay in the browser (encrypted). Start with small amounts.

## Robinhood Chain (Pons)

Pick **Pons · Robinhood Chain** in the lobby (or the Launch card) before hosting or joining. Robinhood wallets live in the
same encrypted account vault (Wallets tab → Robinhood Chain wallets) and are funded with ETH on Robinhood Chain.

Robinhood Chain has no bundles, so a squad launch works like this (`relay/src/pons.js`): the dev pre-signs Pons
`launchAndBuy` with the squad in `snipeTaxExemptions`; the coin and curve addresses are known before the launch, so each
teammate pre-signs `curve.buy` plus a 3% fee transfer to the Robinhood treasury as their next transaction. The relay
re-simulates the launch to learn the curve itself, refuses exemptions outside the lobby, sends the launch, checks nobody
bought in between (the curve's ETH), then fires every buy at once and each fee only after its buy has landed. Teammates'
pages re-check the launch call (they are exempt, the curve is the one it creates) before signing.

Optional relay var `RH_RPC_URL` (a paid Robinhood Chain RPC, tried first); the site's `/api/rh` proxy takes the same.
Check: `node tools/pons-check.mjs` (offline).
