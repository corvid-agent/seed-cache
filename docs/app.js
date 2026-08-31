/* SEED-CACHE — the last 8 seeds, always on the shelf. Reads the app's
   global state from the TestNet indexer and the "ring" box from algod
   (/v2/applications/{id}/box?name=cmluZw== — base64 of "ring") once
   appId > 0 in deploy.json. Live first; on feed failure falls back to the
   last good snapshot (STALE) rather than guessing.
   TestNet only. Read-only. No wallet. No keys. */
(() => {
  const INDEXER = "https://testnet-idx.algonode.cloud";
  const ALGOD = "https://testnet-api.algonode.cloud";
  const EXPLORER = "https://testnet.explorer.perawallet.app/application/";
  const CONTRACT_SRC =
    "https://github.com/corvid-agent/seed-cache/blob/main/smart_contracts/seed_cache/contract.py";
  const DEFAULT_KEEPER = 769891898;
  const DEFAULT_TARGET = 770742777;
  const RING_BOX_B64 = "cmluZw=="; // base64 of "ring"
  const RING_SLOTS = 8;
  const SLOT_SIZE = 40; // 8-byte u64be round + 32-byte seed
  const ROUND_SEC = 2.8;
  const REFRESH_MS = 30000;
  const SNAPSHOT_KEY = "seed-cache:snapshot";

  function b64utf8(b64) {
    try { return atob(b64); } catch { return ""; }
  }

  function b64ToBin(b64) {
    try { return atob(b64); } catch { return ""; }
  }

  function binToHex(bin) {
    let hex = "";
    for (let i = 0; i < bin.length; i++) {
      hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return hex;
  }

  function binToU64(bin, off) {
    // 8-byte big-endian; safe below 2^53 (TestNet rounds are ~1e7).
    let v = 0;
    for (let i = 0; i < 8; i++) {
      v = v * 256 + bin.charCodeAt(off + i);
    }
    return v;
  }

  function decodeRing(boxB64) {
    // Returns [{round, seedHex}] for populated slots, oldest write order
    // unknown off-chain; rounds inside each slot tell the true order.
    const bin = b64ToBin(boxB64);
    if (bin.length < RING_SLOTS * SLOT_SIZE) return [];
    const slots = [];
    for (let i = 0; i < RING_SLOTS; i++) {
      const off = i * SLOT_SIZE;
      const round = binToU64(bin, off);
      const seedHex = binToHex(bin.slice(off + 8, off + SLOT_SIZE));
      if (round > 0) slots.push({ slot: i, round: round, seedHex: seedHex });
    }
    slots.sort((a, b) => b.round - a.round); // freshest first
    return slots;
  }

  function readGlobal(state, name) {
    if (!Array.isArray(state)) return null;
    for (const kv of state) {
      if (b64utf8(kv.key) !== name) continue;
      if (kv.value && kv.value.type === 2) return { kind: "uint", v: kv.value.uint };
      if (kv.value && kv.value.kind === "uint") return kv.value;
      if (kv.value && kv.value.type === 1) return { kind: "bytes", v: kv.value.bytes };
      return null;
    }
    return null;
  }

  async function fetchJson(url, noStore) {
    const opts = { headers: { Accept: "application/json" } };
    if (noStore) opts.cache = "no-store";
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(url + " " + res.status);
    return res.json();
  }

  function flaps(el, text) {
    el.replaceChildren();
    for (const ch of String(text)) {
      const d = document.createElement("span");
      d.className = "flap" + (ch === " " ? " blank" : "");
      d.textContent = ch === " " ? " " : ch;
      el.appendChild(d);
    }
  }

  function setStatus(word, cls, subHtml) {
    const el = document.getElementById("status");
    el.className = "flaps big " + cls;
    flaps(el, word.toUpperCase());
    document.getElementById("subhead").innerHTML = subHtml;
    document.title = "SEED-CACHE — " + word.toUpperCase();
  }

  const STAT_IDS = [
    "stat-stored", "stat-seen", "stat-round", "stat-age",
    "stat-keeper", "stat-target",
  ];

  function fillStats(map) {
    for (const id of STAT_IDS) {
      flaps(document.getElementById(id), map[id] || "—");
    }
  }

  function fillSlots(slots) {
    const body = document.getElementById("slots");
    body.replaceChildren();
    if (!slots.length) {
      const d = document.createElement("div");
      d.className = "meta";
      d.textContent = "shelf empty — no seeds cached yet";
      body.appendChild(d);
      return;
    }
    for (const s of slots) {
      const row = document.createElement("div");
      row.className = "slot-row";
      const head = document.createElement("div");
      head.className = "label";
      head.textContent = "slot " + s.slot + " · round " + s.round;
      const seed = document.createElement("div");
      seed.className = "flaps seed";
      flaps(seed, s.seedHex);
      row.appendChild(head);
      row.appendChild(seed);
      body.appendChild(row);
    }
  }

  function spanLabel(rounds) {
    const sec = Math.abs(rounds) * ROUND_SEC;
    if (sec < 90) return rounds + "r";
    if (sec < 3600) return "~" + Math.round(sec / 60) + "m";
    if (sec < 86400) return "~" + (sec / 3600).toFixed(1) + "h";
    return "~" + (sec / 86400).toFixed(1) + "d";
  }

  function saveSnapshot(snap) {
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    } catch { /* storage unavailable; live-only then */ }
  }

  function loadSnapshot() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function renderSnapshot(snap) {
    const ageMin = Math.max(0, Math.round((Date.now() - snap.ts) / 60000));
    setStatus("STALE", "gate",
      "feed unreachable · last good read " + ageMin + " min ago: " +
      snap.word + (snap.subText ? " · " + snap.subText : ""));
    fillStats(snap.stats || {});
    fillSlots(snap.slots || []);
  }

  let cfgPromise = null;
  function loadConfig() {
    if (!cfgPromise) {
      cfgPromise = fetchJson("./deploy.json", true).then((c) => ({
        appId: Number(c.appId) || 0,
        keeper: Number(c.keeperAppId) || DEFAULT_KEEPER,
        target: Number(c.targetAppId) || DEFAULT_TARGET,
        interval: Number(c.interval) || 1700,
        network: c.network || "testnet",
        notes: c.notes || "",
      }));
    }
    return cfgPromise;
  }

  async function tick() {
    let cfg;
    try {
      cfg = await loadConfig();
    } catch (e) {
      setStatus("FEED DOWN", "down",
        "deploy.json unreadable · showing nothing rather than guessing");
      fillStats({});
      fillSlots([]);
      return;
    }
    document.getElementById("keeper-meta").textContent =
      cfg.network + " · Arcron keeper " + cfg.keeper + " · beacon " + cfg.target;

    if (cfg.appId <= 0) {
      setStatus("NOT DEPLOYED", "gate",
        'contract exists as <a href="' + CONTRACT_SRC + '">source</a> only' +
        " · lights up after TestNet deploy + set_keeper + set_target + Arcron registration");
      fillStats({ "stat-keeper": String(cfg.keeper), "stat-target": String(cfg.target) });
      fillSlots([]);
      return;
    }

    let round, gs, slots = [];
    try {
      const status = await fetchJson(ALGOD + "/v2/status");
      round = status["last-round"];
      const app = await fetchJson(INDEXER + "/v2/applications/" + cfg.appId);
      const params = (app.application && app.application.params) || app.params || {};
      gs = params["global-state"];
      try {
        const box = await fetchJson(
          ALGOD + "/v2/applications/" + cfg.appId + "/box?name=" +
          encodeURIComponent(RING_BOX_B64));
        if (box && box.value) slots = decodeRing(box.value);
      } catch { /* box not created yet — shelf empty */ }
    } catch (e) {
      const snap = loadSnapshot();
      if (snap && snap.appId === cfg.appId) {
        renderSnapshot(snap);
      } else {
        setStatus("FEED DOWN", "down",
          "indexer unreachable · no prior snapshot · showing nothing rather than guessing");
        fillStats({ "stat-keeper": String(cfg.keeper), "stat-target": String(cfg.target) });
        fillSlots([]);
      }
      return;
    }

    const keeperApp = readGlobal(gs, "keeper_app");
    const targetApp = readGlobal(gs, "target_app");
    const stored = readGlobal(gs, "stored");
    const lastSeen = readGlobal(gs, "last_seen_round");

    const nStored = stored && stored.kind === "uint" ? stored.v : 0;
    const nSeen = lastSeen && lastSeen.kind === "uint" ? lastSeen.v : 0;
    const age = nSeen > 0 ? Math.max(0, round - nSeen) : 0;

    const stats = {
      "stat-stored": String(nStored),
      "stat-seen": nSeen > 0 ? String(nSeen) : "—",
      "stat-round": String(round),
      "stat-age": nSeen > 0 ? String(age) + " (" + spanLabel(age) + ")" : "—",
      "stat-keeper": keeperApp && keeperApp.v ? String(keeperApp.v) : "—",
      "stat-target": targetApp && targetApp.v ? String(targetApp.v) : "—",
    };
    fillStats(stats);
    fillSlots(slots);

    const appLink = 'app <a href="' + EXPLORER + cfg.appId + '">' + cfg.appId + "</a>";
    let word, cls, subText;
    if (!keeperApp || keeperApp.v === 0) {
      word = "NO KEEPER"; cls = "gate";
      subText = appLink + " is live but set_keeper has not run yet";
    } else if (!targetApp || targetApp.v === 0) {
      word = "NO TARGET"; cls = "gate";
      subText = appLink + " keeper wired · set_target has not named the beacon yet";
    } else if (nStored === 0) {
      word = "EMPTY"; cls = "gate";
      subText = appLink + " wired to beacon " + targetApp.v +
        " · no seed shelved yet — next keeper tick caches the current reveal";
    } else if (age > cfg.interval * 3) {
      word = "LAGGING"; cls = "down";
      subText = appLink + " last shelved round " + nSeen +
        " · " + spanLabel(age) + " stale (interval " + cfg.interval + "r)" +
        " · check the upkeep escrow";
    } else {
      word = "ON SHELF"; cls = "live";
      subText = appLink + " holds " + Math.min(nStored, RING_SLOTS) +
        " of " + RING_SLOTS + " slots · freshest seed from round " + nSeen +
        " · " + nStored + " stored total";
    }
    setStatus(word, cls, subText);

    saveSnapshot({
      appId: cfg.appId,
      ts: Date.now(),
      word: word,
      subText: subText.replace(/<[^>]*>/g, ""),
      stats: stats,
      slots: slots,
    });
  }

  tick();
  setInterval(tick, REFRESH_MS);
})();
