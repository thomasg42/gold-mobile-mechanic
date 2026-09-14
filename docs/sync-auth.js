/**
 * Device pairing for the operator app.
 *
 * The sync API holds every customer's name, phone, cost basis, clock ledger
 * and receipt photos. For six weeks it held them behind nothing at all: the
 * Worker URL ships in this repository's JavaScript, and `GET /api/jobs`
 * answered anyone who asked. The PIN gate that used to sit there was removed
 * on 2026-07-31 as "low-stakes" — which it was, on a database with no real
 * customers in it. It has real customers in it now.
 *
 * The shape here is deliberate, because the first version of this was removed
 * for being annoying rather than for being wrong:
 *
 *   Thomas types six digits ONCE per phone. That is the whole ceremony.
 *
 * The PIN itself never becomes the API credential. It is exchanged at
 * `/api/pair` for a device token — an HMAC of a random per-device id under the
 * PIN — and the token is what every later request carries. So the thing sent a
 * hundred times a day is 256 bits of signature that cannot be guessed, while
 * the thing a human has to remember stays six digits. Brute force only buys
 * anything at `/api/pair`, which is rate-limited to a handful of tries an hour.
 *
 * The token is a bearer credential and lives in this phone's localStorage.
 * That is the same trust level as being logged in: whoever holds the unlocked
 * phone is the operator. Losing a phone means rotating the PIN, which
 * invalidates every paired device at once — see the README.
 */
(() => {
  "use strict";

  const SYNC_API = "https://gold-mobile-mechanic-sync.forevergoldai.workers.dev";
  const DEVICE_STORAGE = "gmm-device-id";
  const TOKEN_STORAGE = "gmm-sync-token";

  /** Set once he cancels the prompt, so a queue flush cannot nag him per item. */
  let declined = false;
  /** Single-flight: ten queued uploads hitting 401 together must ask once. */
  let pairing = null;

  function read(key) {
    try {
      return window.localStorage.getItem(key) || "";
    } catch {
      // Private-mode Safari throws on access rather than returning null.
      return "";
    }
  }

  function write(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* Unpaired every launch is survivable; a crash here is not. */
    }
  }

  /** Stable, random, and meaningless on its own — it only names this phone. */
  function deviceId() {
    let id = read(DEVICE_STORAGE);
    if (id) return id;
    id = (window.crypto?.randomUUID?.() || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .replace(/[^A-Za-z0-9-]/g, "");
    write(DEVICE_STORAGE, id);
    return id;
  }

  const token = () => read(TOKEN_STORAGE);
  const isPaired = () => Boolean(token());

  function clear() {
    write(TOKEN_STORAGE, "");
  }

  function headers(base) {
    const result = new Headers(base || {});
    const current = token();
    if (current) result.set("Authorization", `Bearer ${current}`);
    return result;
  }

  /**
   * Trades the PIN for this device's token. Returns true once paired.
   *
   * `interactive` is false for anything running on its own — a boot sync, a
   * queue flush when the phone comes back online — because a modal prompt
   * appearing out of nowhere in a driveway is its own kind of broken.
   */
  function ensurePaired({ interactive = false } = {}) {
    if (isPaired()) return Promise.resolve(true);
    if (!interactive || declined) return Promise.resolve(false);
    if (pairing) return pairing;

    pairing = (async () => {
      try {
        const pin = window.prompt(
          "Enter your Gold Mobile Mechanic PIN to pair this phone.\n\nYou only do this once on this device."
        );
        if (pin === null) {
          declined = true;
          return false;
        }
        const entered = String(pin).trim();
        if (!entered) return false;

        const response = await fetch(`${SYNC_API}/api/pair`, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: entered, deviceId: deviceId() })
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body?.token) {
          window.alert(body?.error || "That PIN did not work. Try again.");
          return false;
        }
        write(TOKEN_STORAGE, String(body.token));
        return true;
      } catch {
        window.alert("Could not reach the server to pair this phone.");
        return false;
      } finally {
        pairing = null;
      }
    })();

    return pairing;
  }

  /**
   * `fetch` for every call that needs the operator's identity.
   *
   * A 401 is treated as "this phone is not paired yet" rather than as a failed
   * request: the token is dropped, the PIN is asked for once, and the call is
   * replayed. That is what lets the Worker be locked down while a phone is
   * still running the previous build — it repairs itself on the next tap
   * instead of going dead until someone reinstalls the app.
   *
   * Only replayable bodies are retried. Everything this app sends is a string
   * or a Blob, both of which can be sent twice; a stream could not be.
   */
  async function request(path, options = {}) {
    // Deliberately NOT paired up-front. Asking for a PIN before the server has
    // said it wants one would pop a prompt on a phone talking to a Worker that
    // is not locked yet — which is exactly the state between deploying the app
    // and deploying the Worker. Let the 401 be the thing that asks.
    const send = () => fetch(`${SYNC_API}${path}`, {
      ...options,
      cache: options.cache || "no-store",
      headers: headers(options.headers)
    });

    let response = await send();
    if (response.status === 401) {
      clear();
      const paired = await ensurePaired({ interactive: options.interactive !== false });
      if (paired) response = await send();
    }
    return response;
  }

  window.GMMAuth = { deviceId, token, isPaired, clear, headers, ensurePaired, request, SYNC_API };
})();
