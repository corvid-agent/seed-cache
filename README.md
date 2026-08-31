# seed-cache

**The last 8 seeds, always on the shelf.** A ring-buffer cache of the
[arcron-beacon](https://github.com/corvid-agent/arcron-beacon)'s revealed
seeds on Algorand TestNet, ticked by the
[Arcron](https://github.com/CorvidLabs/arcron) keeper network. Sibling of
[epitaph](https://github.com/corvid-agent/epitaph) and
[plod](https://github.com/corvid-agent/plod).

**Unaudited. TestNet only. Not deployed (appId = 0).** Deploy needs a
human's explicit go — see issue #1.

## What it does

The beacon (TestNet app **770742777**) reveals a fresh 32-byte seed every
~1,700 rounds into its global state (`revealed_round`, `revealed_seed`).
Anything that wants the seed has to read the beacon itself — foreign-app
reads, access lists, opcode budget. seed-cache takes that cost once, on a
keeper tick, and leaves the last eight seeds sitting in one box anyone can
`read(slot)` with a single ABI call:

- Every Arcron keeper call to `store()` does a **cross-app read** of the
  beacon's globals (`app_global_get_ex`, ok-flag checked, never asserted).
- A fresh reveal is appended to the next slot of an 8-slot **ring** held in
  one box named `ring` — 8 slots × 40 bytes = 320 bytes, each slot an
  8-byte big-endian round followed by the 32-byte seed.
- `read(slot)` (readonly) returns the 40-byte slot: the round it was
  revealed at and the seed itself.

The ring overwrites oldest-first, so the shelf always holds the eight most
recent reveals — about 3.8 hours of beacon history at a 1,700-round
cadence.

## Ring layout

One box, name `ring` (base64 `cmluZw==`), 320 bytes:

```
offset   0   slot 0   [ round u64be ][ seed 32B ]
offset  40   slot 1   [ round u64be ][ seed 32B ]
offset  80   slot 2   [ round u64be ][ seed 32B ]
offset 120   slot 3   [ round u64be ][ seed 32B ]
offset 160   slot 4   [ round u64be ][ seed 32B ]
offset 200   slot 5   [ round u64be ][ seed 32B ]
offset 240   slot 6   [ round u64be ][ seed 32B ]
offset 280   slot 7   [ round u64be ][ seed 32B ]

write slot = stored % 8        (stored = total seeds ever cached)
```

## Box MBR math

Boxes are paid for by the **application account**, not the caller:

```
MBR = 2500 + 400 × (len(name) + size)
    = 2500 + 400 × (4 + 320)
    = 132100 µALGO
```

**The deployer funds the app address with 0.2 ALGO at deploy time** —
132,100 µALGO covers the ring box MBR and the rest is inner-fee / fee
headroom. Without it the first `store()` cannot create the box (it bails
soft and returns 0, per the fail-soft rule — but nothing is ever cached
until the MBR is there).

Keeper bots do **not** need the box or the foreign app pre-declared in the
registration: Arcron's keeper_bot resolves them per execution via
simulate-based resource resolution
([`_resolve_execute_references`](https://github.com/CorvidLabs/arcron/blob/main/keeper_bot)),
which auto-attaches the `ring` box reference and the beacon app to the
foreign-apps array on each `execute()` call. Registration carries only the
bare `store()` selector.

## State layout (global)

Declared order; keys are stored by name. Schema from the compiled arc56:
**4 uint64 + 0 byte slices**, no local state.

| slot | key              | type   | meaning                                        |
| ---- | ---------------- | ------ | ---------------------------------------------- |
| 0    | `keeper_app`     | uint64 | Arcron keeper app id; 0 until `set_keeper`     |
| 1    | `target_app`     | uint64 | beacon app id (770742777); 0 until `set_target` |
| 2    | `stored`         | uint64 | total seeds ever stored; write slot = `stored % 8` |
| 3    | `last_seen_round`| uint64 | last `revealed_round` consumed; dedupes ticks  |

Plus one box: `ring`, 320 bytes (layout above).

## ABI

Selectors are `sha512_256(signature)[:4]`, as compiled by puyapy 5.10.1.

| method                   | selector     | auth               | notes                                        |
| ------------------------ | ------------ | ------------------ | -------------------------------------------- |
| `create()void`           | `0x4c5c61ba` | (create)           | zero create args, on purpose                 |
| `set_keeper(uint64)void` | `0xc4c1d8f7` | creator, one-time  | ABI lowers `Application` to `uint64`         |
| `set_target(uint64)void` | `0x376988ee` | creator, one-time  | beacon = 770742777                           |
| `store()uint64`          | `0x6c5a8989` | keeper app account | fail-soft; returns total stored              |
| `read(uint64)byte[]`     | `0xfc0d0547` | readonly           | the 40-byte slot: round + seed               |

## The traps this contract avoids

Read [docs/integrating.md](https://github.com/CorvidLabs/arcron/blob/main/docs/integrating.md)
in the Arcron repo first. Every one of these was learned the hard way:

1. **Zero create args.** A uint64 create_arg is how a sloppy deploy script
   confuses the keeper app id with a cadence. `create()` takes nothing;
   the keeper is named once via `set_keeper`, the beacon once via
   `set_target`.
2. **Keeper auth is `Application(keeper).address`, never `itob`.** Arcron's
   inner call comes from the keeper *application account*. Comparing the
   sender against `itob(keeper_app_id)` compares 8 bytes to a 32-byte
   address and never matches.
3. **Fail soft after keeper auth.** A hook that rejects gets exponentially
   backed off by keeper bots and burns upkeep escrow on retries. After the
   two authorization asserts in `store()`, every no-work path **returns
   0** — target unset, beacon keys missing (get_ex ok flags, never
   asserted), round already cached, seed not 32 bytes, box unavailable.
   Nothing asserts once the keeper is authenticated.
4. **`set_keeper` / `set_target` are one-time, creator-only.** Set once
   after deploy, before registration; they cannot be re-pointed.
5. **Compile clean.** Verified: puyapy 5.10.1 compiles this contract with
   zero errors (artifacts committed under `smart_contracts/seed_cache/out/`).

## Keeper registration recipe

Register an upkeep on the Arcron TestNet keeper app **769891898**
(address `M4YFP33L5VIFRF53X53WUMQWBOWSLYQNBSSAJV2SORGF43L36XBY7OREUA`) via

```
register(pay,pay,uint64,byte[][],uint64,uint64,uint64,uint64,uint64,uint64)uint64
```

with:

- **target app** = the deployed seed-cache app id; **call args** = the bare
  `store()` selector (`0x6c5a8989`), ABI-encoded as `byte[][]`
  (10 bytes on the wire: count + offset + length + selector).
- **interval = 1700 rounds** — matching the beacon's reveal cadence, so
  each tick has a fresh seed to shelve (dedup by `last_seen_round` makes a
  late or early tick a harmless 0).
- **fee per execution = 4000 µALGO**.
- **skip policy = 1 (SKIP_AHEAD)** — a missed call just shelves the seed a
  tick late; the ring catches up on the next call. Never leave the zero
  default.
- **payment 1 = MBR**, to the keeper app address:
  `2500 + 400 × (139 + len(call_args))` µALGO → for the bare selector,
  `2500 + 400 × 149 = 62100` µALGO.
- **payment 2 = escrow**, to the keeper app address: **500000 µALGO**
  (125 executions at 4000 µALGO; top up before it runs dry).
- Both payments go to the **keeper app address** (escrow address of app
  769891898), not to seed-cache.
- After registering, read the upkeep box `u` + `itob(upkeep_id)` **fresh**
  from the keeper app (indexer `/v2/applications/769891898/box?name=...`)
  — never trust a cached copy when checking `next_execution_round`.

Order matters: deploy → fund app address 0.2 ALGO → `set_keeper` →
`set_target` → register, because `store` hard-asserts until the keeper is
set (and fail-softs until the target is).

## How a human deploys this later

**TestNet only. Never commit a mnemonic. Never deploy without the human go
(issue #1).**

1. Fund a throwaway TestNet account (dispenser). The mnemonic lives in
   env/CI secrets, never in git.
2. Compile: `puyapy smart_contracts/seed_cache/contract.py --out-dir out`
   (or reuse the committed artifacts).
3. Deploy the app with **zero create args**. Record the app id.
4. **Fund the app address with 0.2 ALGO** — 132,100 µALGO of box MBR for
   the `ring` box plus inner-fee headroom.
5. Call `set_keeper` with keeper app **769891898** (creator-only, one-time).
6. Call `set_target` with beacon app **770742777** (creator-only, one-time).
7. Register the upkeep on keeper 769891898 per the recipe above (issue #2).
8. Set `"appId"` in `docs/deploy.json` — the board lights up on its own
   (issue #3).

## Layout

```
smart_contracts/seed_cache/contract.py   the Puya (Algorand Python) source — the whole thing
smart_contracts/seed_cache/out/          committed puyapy 5.10.1 artifacts (arc56 + TEAL)
docs/                                    GitHub Pages split-flap board (NOT DEPLOYED until appId > 0)
docs/deploy.json                         {"appId": 0, ...} — the board's single source of config
```

Compiled artifacts are committed here on purpose (unlike arcron-beacon) so
the reviewed bytecode hash is pinned in git.

**Pending:** the token that wrote this repo lacks the `workflow` scope, so
no Pages publish workflow is committed. **A human must enable GitHub Pages
from `/docs` on `main` in the repository settings** (Settings → Pages →
Source: Deploy from a branch → `main` `/docs`). A `pages.yml` copied from
[corvid-agent/plod](https://github.com/corvid-agent/plod) is welcome when a
suitably-scoped credential exists.

## Build locally

```bash
pip install puyapy==5.10.1
puyapy smart_contracts/seed_cache/contract.py --out-dir out
```

Verified at authoring time: compiles clean on puyapy 5.10.1; global schema
4 uint64 + 0 byte slices; selectors as tabulated above. Mock-chain tests
cannot prove keeper integration (inner calls, MBR, foreign reads) — that
belongs to a LocalNet/TestNet e2e at deploy time.

## The board

`docs/` is a split-flap/CRT status board in the spirit of
[corvid-agent/arcron-beacon](https://github.com/corvid-agent/arcron-beacon)
and [corvid-agent/waddle](https://github.com/corvid-agent/waddle). While
`appId` is 0 it shows **NOT DEPLOYED**. Once `appId > 0` it reads the app's
global state from the public indexer
(`https://testnet-idx.algonode.cloud`) and the `ring` box from algod
(`https://testnet-api.algonode.cloud/v2/applications/{id}/box?name=cmluZw==`
— base64 of `ring`), then flaps out the stored count, `last_seen_round`,
and all eight ring slots decoded as round + seed hex. If the feed is
unreachable it falls back to the last good snapshot (marked STALE) rather
than guessing. Read-only, no wallet, no keys.

Unaudited. TestNet only. Not deployed.
