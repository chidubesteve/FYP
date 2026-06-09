/**
 * dataGenerator.ts
 *
 * Generates synthetic IoT telemetry payloads for the TrustFlowDT simulation.
 * Produces two categories of readings: normal (within operational bounds) and
 * anomalous (outside bounds, replay attacks, or signature-free), to support
 * controlled evaluation of oracle anomaly detection accuracy.
 *
 * Normal temperature range: 18–25 °C with ±1.5 °C Gaussian-approximated noise.
 * This range is representative of an indoor HVAC monitoring scenario.
 *
 * @author  Chidube Steve Anike (25020251) — Staffordshire University FYP
 */

import crypto from "crypto";

// ============================================================================
// Types
// ============================================================================

export type AnomalyType =
  | "spike" // value far outside operational bounds
  | "flatline" // value frozen — indicative of sensor failure
  | "replay" // stale timestamp reused from a previous message
  | "no_signature" // payload missing cryptographic attestation
  | "invalid_sig"; // signature present but does not verify against payload

export interface TelemetryPayload {
  deviceId: string;
  sensorType: string;
  value: number;
  unit: string;
  timestamp: number; // Unix ms
  signature: string | null;
  anomalyType?: AnomalyType; // present only on injected anomalies
}

// ============================================================================
// Key management — simulated device key pair (TEE attestation simulation)
// In production these would be hardware-rooted keys in a Trusted Execution
// Environment. For PoC purposes, key pairs are generated in software.
// Limitation acknowledged: software keys do not provide hardware-level
// non-extractability guarantees (cf. ARM TrustZone, Intel SGX).
// ============================================================================

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

export const DEVICE_PUBLIC_KEY = publicKey;

/**
 * Sign a telemetry payload with the simulated device private key.
 * The signature covers the canonical string: `${deviceId}:${value}:${timestamp}`
 * This is intentionally minimal to reflect constrained-device computation limits.
 */
function signPayload(
  deviceId: string,
  value: number,
  timestamp: number,
): string {
  const canonical = `${deviceId}:${value}:${timestamp}`;
  const sign = crypto.createSign("SHA256");
  sign.update(canonical);
  return sign.sign(privateKey, "base64");
}

// ============================================================================
// Normal data generation
// ============================================================================

/**
 * Approximate Gaussian noise using Box–Muller transform.
 * Used to produce realistic sensor noise rather than uniform random values,
 * which would produce an unnaturally flat distribution.
 */
function gaussianNoise(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return parseFloat((mean + stdDev * z).toFixed(2));
}

/**
 * Generate a single normal temperature telemetry payload.
 * @param deviceId  Registered device identifier string.
 */
export function generateNormal(deviceId: string): TelemetryPayload {
  const value = gaussianNoise(21.5, 1.5); // mean 21.5 °C, σ = 1.5
  const timestamp = Date.now();
  return {
    deviceId,
    sensorType: "temperature",
    value,
    unit: "celsius",
    timestamp,
    signature: signPayload(deviceId, value, timestamp),
  };
}

// ============================================================================
// Anomaly injection
// Used in controlled evaluation: inject N anomalies of known types and measure
// oracle detection rate to evaluate the 85% accuracy criterion.
// ============================================================================

/**
 * Generate an anomalous payload of a specified type for oracle evaluation.
 * @param deviceId    Registered device identifier.
 * @param type        The category of anomaly to inject.
 * @param staleTs     Required when type === "replay" — the timestamp to reuse.
 */
export function generateAnomaly(
  deviceId: string,
  type: AnomalyType,
  staleTs?: number,
): TelemetryPayload {
  const timestamp = Date.now();

  switch (type) {
    case "spike": {
      // Temperature spike far outside operational bounds (150–250 °C).
      // Simulates sensor compromise or data injection attack.
      const value = parseFloat((150 + Math.random() * 100).toFixed(2));
      return {
        deviceId,
        sensorType: "temperature",
        value,
        unit: "celsius",
        timestamp,
        signature: signPayload(deviceId, value, timestamp),
        anomalyType: "spike",
      };
    }

    case "flatline": {
      // Sensor value frozen at exactly 0 — indicative of sensor failure or
      // deliberate spoofing to mask a physical event.
      return {
        deviceId,
        sensorType: "temperature",
        value: 0.0,
        unit: "celsius",
        timestamp,
        signature: signPayload(deviceId, 0.0, timestamp),
        anomalyType: "flatline",
      };
    }

    case "replay": {
      // Reuse a stale timestamp. Replay attacks exploit the fact that a valid
      // signature on an old message still verifies correctly.
      // Detection requires the oracle to enforce timestamp freshness windows.
      const ts = staleTs ?? timestamp - 120_000; // default: 2 min stale
      const value = gaussianNoise(21.5, 1.5);
      return {
        deviceId,
        sensorType: "temperature",
        value,
        unit: "celsius",
        timestamp: ts,
        signature: signPayload(deviceId, value, ts), // valid sig on stale ts
        anomalyType: "replay",
      };
    }

    case "no_signature": {
      // Payload entirely missing a signature — simulates an unauthenticated device
      // or a message that bypassed the TEE signing step.
      const value = gaussianNoise(21.5, 1.5);
      return {
        deviceId,
        sensorType: "temperature",
        value,
        unit: "celsius",
        timestamp,
        signature: null,
        anomalyType: "no_signature",
      };
    }

    case "invalid_sig": {
      // Payload carries a signature that does not correspond to the payload content.
      // Simulates data manipulation after signing — the most sophisticated attack vector.
      const value = gaussianNoise(21.5, 1.5);
      return {
        deviceId,
        sensorType: "temperature",
        value,
        unit: "celsius",
        timestamp,
        signature: "dGhpcyBpcyBub3QgYSB2YWxpZCBzaWduYXR1cmU=", // base64 garbage
        anomalyType: "invalid_sig",
      };
    }

    default:
      throw new Error(`Unknown anomaly type: ${type}`);
  }
}
