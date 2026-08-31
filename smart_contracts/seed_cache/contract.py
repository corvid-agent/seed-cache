# pyright: reportMissingModuleSource=false
"""SEED-CACHE - the last 8 arcron-beacon seeds, always on the shelf.

A ring-buffer cache on Algorand TestNet that mirrors the 32-byte seeds
revealed by arcron-beacon (target app 770742777). Ticked by the Arcron
keeper network: every keeper call to `store()` reads the beacon's
`revealed_round` / `revealed_seed` globals via a cross-app foreign read
and appends the (round, seed) pair to the next slot of an 8-slot ring
held in one box named "ring" (8 slots x 40 bytes = 320 bytes; slot =
8-byte big-endian round + 32-byte seed). Anyone can then `read(slot)`
to pull a recent seed without touching the beacon at all.

The keeper hook is fail-soft by design (see the traps list in README.md):

  * Zero-argument hook. `store()` takes no args; Arcron supplies none.
    A keeper decides *when* store runs, never *what* it stores.
  * Authorization is Application(keeper).address - the sender of Arcron's
    inner call. Never compare against itob(keeper_app_id); that is 8
    bytes, not an address.
  * FAIL SOFT. A hook that rejects gets backed off by keeper bots (1, 2,
    4... intervals) until the schedule quietly stops and burns escrow on
    retries. After the two authorization asserts, every no-work path here
    RETURNS 0 - target unset, beacon keys missing, round unchanged, box
    unavailable, all of them. Nothing asserts once the keeper is
    authenticated. Cross-app reads use get_ex ok flags; box_create's ok
    flag is honored the same way.
  * Zero create args. A uint64 create_arg is how a sloppy deploy script
    confuses the keeper app id with a cadence. There is nothing to pass
    at create; the keeper is named once via `set_keeper`, the beacon once
    via `set_target`.

BOX MBR: the ring box costs 2500 + 400*(4+320) = 132100 microALGO,
paid from the app's own balance. The deployer funds the app address
with 0.2 ALGO at deploy time (box MBR + inner-fee headroom). Keeper
bots auto-attach the box and the foreign app reference via
simulate-based resource resolution (arcron keeper_bot
_resolve_execute_references), so registration needs only the bare
`store()` selector.

TestNet only. Unaudited. Not deployed (appId = 0 until a human deploys).
"""

from typing import Final

from algopy import (
    ARC4Contract,
    Application,
    Box,
    Bytes,
    Global,
    GlobalState,
    Txn,
    UInt64,
)
from algopy.arc4 import UInt64 as ARC4UInt64
from algopy.arc4 import abimethod
from algopy.op import AppGlobal

# Ring geometry: 8 slots, each 8-byte round + 32-byte seed = 40 bytes,
# one 320-byte box named "ring".
RING_SLOTS: Final = 8
SLOT_SIZE: Final = 40
RING_SIZE: Final = 320
SEED_SIZE: Final = 32


class SeedCache(ARC4Contract):
    """Ring buffer of the arcron-beacon's last 8 revealed seeds.

    TestNet only. Unaudited. Not a product.
    """

    def __init__(self) -> None:
        # App id of the Arcron keeper allowed to call `store`. Zero until
        # `set_keeper`. Not an interval. Not a create arg.
        self.keeper_app = GlobalState(UInt64(0))
        # App id of the beacon whose seeds are cached (770742777 on
        # TestNet). Zero until `set_target`.
        self.target_app = GlobalState(UInt64(0))
        # Total seeds ever stored. The write slot is stored % 8.
        self.stored = GlobalState(UInt64(0))
        # Last revealed_round consumed, so a keeper tick between reveals
        # is a no-op instead of a duplicate write.
        self.last_seen_round = GlobalState(UInt64(0))
        # The shelf itself: one box, 8 slots x 40 bytes.
        self.ring = Box(Bytes, key=b"ring")

    @abimethod(create="require")
    def create(self) -> None:
        """No-op create. Zero arguments on purpose.

        Never take a uint64 create arg that a deploy script might map to
        the keeper app id. Nothing to pass here.
        """
        self.keeper_app.value = UInt64(0)
        self.target_app.value = UInt64(0)
        self.stored.value = UInt64(0)
        self.last_seen_round.value = UInt64(0)

    @abimethod()
    def set_keeper(self, keeper: Application) -> None:
        """Name the Arcron keeper whose app account may call `store`.

        Creator-only, one-time. Pass the keeper *application*, not a raw
        uint64. `store` authorizes Application(keeper).address - the
        inner-call sender when Arcron `execute()` inner-calls this app -
        never itob(keeper.id). Puya lowers the Application param to
        uint64 in the ABI signature; the compiled selector is
        set_keeper(uint64)void.
        """
        assert Txn.sender == Global.creator_address, "Only the creator can set the keeper"
        assert self.keeper_app.value == 0, "Keeper already set"
        assert keeper.id != 0, "Keeper app required"
        self.keeper_app.value = keeper.id

    @abimethod()
    def set_target(self, target: Application) -> None:
        """Name the beacon app whose revealed seeds are cached.

        Creator-only, one-time. TestNet beacon is app 770742777.
        """
        assert Txn.sender == Global.creator_address, "Only the creator can set the target"
        assert self.target_app.value == 0, "Target already set"
        assert target.id != 0, "Target app required"
        self.target_app.value = target.id

    @abimethod()
    def store(self) -> UInt64:
        """Arcron hook. Zero arguments; the selector is the only app arg.

        Returns the total seeds stored after this call, 0 on every
        no-work path. FAIL SOFT: after the two authorization asserts
        nothing here may reject - a failing hook gets exponentially
        backed off by keeper bots and burns upkeep escrow on retries.

        No-work paths, all returning 0: target unset; either beacon key
        missing from the foreign read (get_ex ok flag, never asserted);
        revealed_round zero or already cached; seed not 32 bytes; ring
        box unavailable. On a fresh reveal: create the box if absent,
        write slot (stored % 8) * 40, bump stored and last_seen_round.
        """
        keeper = self.keeper_app.value
        assert keeper != 0, "Keeper not set"
        # Inner-call sender is the keeper *app account*, not itob(keeper.id).
        assert (
            Txn.sender == Application(keeper).address
        ), "Only the keeper app may store"

        # Beacon not named yet - nothing to read.
        target = self.target_app.value
        if target == 0:
            return UInt64(0)

        # Cross-app reads are fail-soft: get_ex returns an ok flag and
        # never asserts on a missing key or a missing foreign app.
        revealed_round, ok_round = AppGlobal.get_ex_uint64(
            Application(target), b"revealed_round"
        )
        revealed_seed, ok_seed = AppGlobal.get_ex_bytes(
            Application(target), b"revealed_seed"
        )
        if not ok_round or not ok_seed:
            return UInt64(0)

        # Never revealed, or already on the shelf - no duplicate writes.
        if revealed_round == 0:
            return UInt64(0)
        if revealed_round == self.last_seen_round.value:
            return UInt64(0)

        # A seed is exactly 32 bytes; anything else is not a seed. Bail
        # soft rather than let box_replace below overflow the ring.
        if revealed_seed.length != SEED_SIZE:
            return UInt64(0)

        # Create the shelf on first use. box_create returns an ok flag;
        # if it fails because the box already exists we proceed to
        # replace, and if the box is still absent we bail soft instead
        # of letting box_replace assert.
        if not self.ring:
            if not self.ring.create(size=UInt64(RING_SIZE)):
                if not self.ring:
                    return UInt64(0)

        stored = self.stored.value
        slot = stored % RING_SLOTS
        # Slot payload: 8-byte big-endian round + 32-byte seed. The ARC4
        # uint64 .bytes encoding IS itob (big-endian); it packs data here,
        # it is never used for auth.
        self.ring.replace(
            slot * SLOT_SIZE, ARC4UInt64(revealed_round).bytes + revealed_seed
        )
        self.stored.value = stored + 1
        self.last_seen_round.value = revealed_round
        return self.stored.value

    @abimethod(readonly=True)
    def read(self, slot: UInt64) -> Bytes:
        """Return the 40-byte ring slot: 8-byte round + 32-byte seed.

        Public read, no auth; the asserts here are input validation,
        not keeper-hook failure modes. Slot must be under 8 and the
        shelf must exist.
        """
        assert slot < RING_SLOTS, "Slot out of range"
        assert self.ring, "Ring box not created"
        return self.ring.extract(slot * SLOT_SIZE, SLOT_SIZE)
