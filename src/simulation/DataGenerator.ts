/**
 *  * dataGenerator.ts
 *
 * Simulates a physical IoT device producing signed telemetry. Each reading is
 * a Telemetry object that is canonically serialised, SHA-256 hashed and signed
 * with an ECDSA secp256k1 private key. The resulting SignedTelemetry object is
 * what the oracle later verifies.
 *
 * secp256k1 is chosen so the same key material and signature format used on
 * the simulated device aligns with the curve used by Ethereum and Base Sepolia
 * downstream. this removes the need for an extra signature verification step. this is a software-simulated TEE. A real deployment would
 * generate and hold the private key inside a hardware secure element.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomBytes,
  KeyObject,
} from "crypto";
import stringify from "canonical-json"; // for deterministic JSON stringification with consistent key ordering, used in signing and verification to ensure the same canonical string is produced on both sides. Why is this important?

// Types
// sensor readings prior to signing

// should this still be flat since i am now using a dedicated canonical-json library for deterministic serialisation?
export interface TelemetryPayload {
  deviceId: string; // identifier of the emitting device. must match an entry in the registry
  sensorType: string; // reading type, e.g. "temperature", "pressure", "vibration"
  value: number; // reading value
  unit: string; // unit of measurement eg "Celsius", "Pascal", "kPa", " "m/s^2"
  timestamp: number; // Unix epoch ms timestamp of when the reading was taken on the device
  nonce: string; // random nonce to ensure unique payload hash for each reading, even if other fields are identical
}

/**
 * SignedTelemetry is the data structure published by the simulated device on trustflow/raw/{deviceId} topic and consumed by the oracle. It includes the original TelemetryPayload fields plus a signature field.
 */

export interface SignedTelemetry {
  payload: TelemetryPayload;
  signature: string; // DER-encoded ECDSA signature, hex encoded
}

// A keypair container for the simulated device. In production, the private key would be hardware-rooted and non-extractable in a TEE, and only the public key would be registered on-chain.both stored as PEM-encoded strings. Why are they stored as pem strings please? is there an advantage or downside it brings?

export interface DeviceKeyPair {
  publicKey: string; // PEM-encoded public key
  privateKey: string; // PEM-encoded private key
}

export interface SensorConfig {
  sensorType: string; // e.g. "temperature", "pressure", "vibration"
  unit: string; // e.g. "Celsius", "Pascal", "kPa", "m/s^2"
  minValue: number; // minimum realistic value for this sensor type for normal operation
  maxValue: number; // maximum realistic value for this sensor type for normal operation
  maxDrift: number; // maximum realistic change from one reading to the next for normal operation, used to simulate gradual changes and prevent unrealistic jumps
  startValue?: number; // optional initial value for the sensor reading, if not provided the midpoint value within min/max will be used
}

/**
 * Generate an ECDSA secp256k1 key pair, PEM encoded. this would be called once at device provisioning time and the public key would be registered on-chain while the private key would be securely stored in the device's TEE.
 */

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "secp256k1",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}

/**
 * Canonical serialization and signing of a telemetry payload. The signature is computed over the canonical JSON string of the payload to ensure deterministic signing and verification. The resulting SignedTelemetry object includes both the original payload and the signature.
 */

export function canonicaliseTelemetry(payload: TelemetryPayload): string {
  // Canonical JSON serialization using the canonical-json library
  // This ensures consistent key ordering and formatting for signing and verification.

  // does the order matter? and why?
  const { deviceId, nonce, sensorType, timestamp, unit, value } = payload;

  if (
    deviceId == null ||
    nonce == null ||
    sensorType == null ||
    timestamp == null ||
    unit == null ||
    value == null
  ) {
    throw new Error("Missing required telemetry field");
    }

  const order = {
    deviceId,
    nonce,
    sensorType,
    timestamp,
    unit,
    value,
  };
  return stringify(order);
}

/**
 * compute the sha256 hash of the canonical JSON string of the payload, then sign that hash with the device's private key. The signature is returned as a Buffer
 */

function digestTelemetry(payload: TelemetryPayload): Buffer {
  const canonical = canonicaliseTelemetry(payload);
  return createHash("sha256").update(canonical, "utf8").digest();
}

/**
 * Sign a telemetry payload with the device's private key. The signature is computed over the SHA-256 hash of the canonical JSON string of the payload. The resulting signature is DER-encoded and hex-encoded for compactness and compatibility with Ethereum's ecrecover SignedTelemetry ready for publication
 */

export function signTelemetry(
  payload: TelemetryPayload,
  privateKeyPem: string,
): SignedTelemetry {
  const key: KeyObject = createPrivateKey({
    key: privateKeyPem,
    format: "pem",
  });
  const signer = createSign("SHA256");
  signer.update(canonicaliseTelemetry(payload)); // if it is digestTelemetry it would be double hashed so SHA256(SHA256(canonical)). the signer needs the raw canonical string to produce the correct signature that the verifier will expect. if i pass the digest it would be signing the hash of the canonical string, which is not what the verifier is expecting. the verifier expects the signature to be over the canonical string itself, and it will perform the same hashing internally during verification. so passing the digest would lead to an incorrect signature that fails verification.
  signer.end();
  const signature = signer.sign(key).toString("hex");
  return { payload, signature };
}

/**
 *  * Verify a SignedTelemetry against an expected public key (PEM). Returns true
 * if the signature is valid for the canonical form of the payload under the public key, false otherwise.
 */

export function verifyTelemetry(
  signed: SignedTelemetry,
  publicKeyPem: string,
): boolean {
  try {
    const key: KeyObject = createPublicKey({
      key: publicKeyPem,
      format: "pem",
    });
    const verifier = createVerify("SHA256");
    verifier.update(canonicaliseTelemetry(signed.payload), "utf8"); // should this be digestTelemetry or canonicaliseTelemetry? and why?
    verifier.end();
    return verifier.verify(key, Buffer.from(signed.signature, "hex"));
  } catch (error) {
    return false; // any error in the verification process results in a failed verification
  }
}

// then waht is the use of the digestTelemetry function?
/**
 * It is not used in the sign/verify path. It exists for the oracle's batch composition logic (Phase 2 of the build). When the oracle buffers N=10 validated readings before anchoring to the chain, it needs to produce a single composite hash representing all of them — a Merkle-style aggregation. That is where digestTelemetry is useful: computing SHA256(canonical) for each reading to feed into the batch hash. It is exported in anticipation of that use in oracle.ts.
 */
export { digestTelemetry };

// Stateful data generator simulator
export class DataGenerator {
  private readonly deviceId: string;
  private readonly privateKey: string;
  private readonly config: SensorConfig;
  private currentValue: number;

  constructor(deviceId: string, privateKeyPem: string, config: SensorConfig) {
    if (config.minValue >= config.maxValue) {
      throw new Error(
        "SensorConfig.minValue must be strictly less than maxValue",
      );
    }
    if (config.maxDrift <= 0) {
      throw new Error("SensorConfig.maxDrift must be positive");
    }
    this.deviceId = deviceId;
    this.privateKey = privateKeyPem;
    this.config = config;
    this.currentValue =
      config.startValue ?? (config.minValue + config.maxValue) / 2;
  }

  /**
   * Generate and sign the next telemetry reading. Pure with respect to broker
   * I/O: the caller decides where the result is sent.
   */
  public next(): SignedTelemetry {
    this.advance();
    const payload: TelemetryPayload = {
      deviceId: this.deviceId,
      sensorType: this.config.sensorType,
      value: roundTo(this.currentValue, 4),
      unit: this.config.unit,
      timestamp: Date.now(),
      nonce: randomBytes(16).toString("hex"),
    };
    return signTelemetry(payload, this.privateKey);
  }

  /**
   * Step the underlying random walk forward by one tick. The step is drawn
   * uniformly from [-maxDrift, +maxDrift] and clipped to the configured range.
   */
  private advance(): void {
    const step = (Math.random() * 2 - 1) * this.config.maxDrift;
    let next = this.currentValue + step;
    if (next < this.config.minValue) next = this.config.minValue;
    if (next > this.config.maxValue) next = this.config.maxValue;
    this.currentValue = next;
  }

  /** Override the current value, used by the anomaly injector. */
  public setValue(value: number): void {
    this.currentValue = value;
  }

  /** Read-only access to the configured sensor type for logging. */
  public getSensorType(): string {
    return this.config.sensorType;
  }
}

/**
 * Round to a fixed number of decimal places without exposing JavaScript's
 * full floating-point representation in the wire payload.
 */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
 