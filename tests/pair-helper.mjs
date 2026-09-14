/**
 * Mints a device token the way the Worker does, so every other suite can call
 * the protected routes without going through the pairing round trip.
 *
 * Derived INDEPENDENTLY here, with node:crypto rather than by importing the
 * Worker's own helper. If the two ever disagree the tests fail, which is the
 * point: a test that signs with the code under test proves only that the code
 * agrees with itself.
 */
import { createHmac } from "node:crypto";

export const TEST_PIN = "406117";
export const TEST_DEVICE = "test-device-0001";

export function deviceToken(pin = TEST_PIN, deviceId = TEST_DEVICE) {
  const signature = createHmac("sha256", pin)
    .update(`gmm-device|v1|${deviceId}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${deviceId}.${signature}`;
}

export function authHeader(pin = TEST_PIN, deviceId = TEST_DEVICE) {
  return { Authorization: `Bearer ${deviceToken(pin, deviceId)}` };
}
