/**
 * publisher.ts
 *
 * Simulated device entry point for MQTT publishing. This module initializes the MQTT client and simulates. loads and generates an ECDSA secp256k1 keypair,
 * connects to the configured MQTT broker, and publishes signed telemetry on the specified path/topic (trustflow/raw/{deviceId}) at the configured rate
 */

import { MqttClient } from "mqtt";
import { promises as fs } from "fs";
import path from "path";

import {
  createMqttClient,
  disconnectMqttClient,
} from "../config/mqttClient.js";

import {
  DataGenerator,
  type DeviceKeyPair,
  generateDeviceKeyPair,
  type SensorConfig,
  type SignedTelemetry,
} from "../simulation/DataGenerator.js";
import { fileURLToPath } from "url";

// does the publisher broker need all these options/parameters? when i tested it i didn't pass any of this i just created a topic and published to it. and the subscriber recieved it. also what is keypath, as i have seen i don't have that or a keys directory?
interface PublisherConfig {
  brokerUrl: string;
  deviceId: string;
  keyPath: string;
  intervalMs: number;
  durationMs: number;
  sensor: SensorConfig;
}

function loadConfig(): PublisherConfig {
  const deviceId = process.env.TRUSTFLOW_DEVICE_ID ?? "device-001";
  const keyPath =
    process.env.TRUSTFLOW_KEY_PATH ?? path.join("keys", `${deviceId}.json`);

  return {
    brokerUrl: process.env.TRUSTFLOW_BROKER_URL ?? "mqtt://localhost:1883",
    deviceId,
    keyPath,
    intervalMs: parsePositiveInt(process.env.TRUSTFLOW_INTERVAL_MS, 1000),
    durationMs: parsePositiveInt(process.env.TRUSTFLOW_DURATION_MS, 0),
    sensor: {
      sensorType: "temperature",
      unit: "celsius",
      minValue: 18,
      maxValue: 26,
      maxDrift: 0.3,
      startValue: 22,
    },
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Load a keypair from disk, or generate and persist one if no file exists at
 * the given path. Keys are stored as a JSON object containing the PEM strings.
 *
 * In a production deployment the private key would never leave the device's
 * secure element. This file-based approach is acknowledged in the proposal as
 * a software-simulated TEE for development and evaluation.
 */

async function loadOrCreateKeyPair(keyPath: string): Promise<DeviceKeyPair> {
  try {
    const raw = await fs.readFile(keyPath, "utf8");
    const parsed = JSON.parse(raw) as DeviceKeyPair;
    if (!parsed.privateKey || !parsed.publicKey) {
      throw new Error("Key file is missing  required fields");
    }
    console.log(`[publisher] loaded existing keypair from ${keyPath}`);
    return parsed;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
    const fresh = generateDeviceKeyPair();
    await fs.mkdir(path.dirname(keyPath), { recursive: true });
    await fs.writeFile(keyPath, JSON.stringify(fresh, null, 2), "utf8");
    console.log(`[publisher] generated new keypair at ${keyPath}`);
    return fresh;
  }
}

/**
 * resolves the MQTT topic for the raw telemetry from a given device
 * @param deviceId
 * @returns a topic string
 */
function rawTopicFor(deviceId: string): string {
  return `trustflow/raw/${deviceId}`;
}

/**
 * publish a signed reading. Resolves once the broker acknowledges the
 * PUBLISH (QoS 1 PUBACK), which is the latency anchor point we will measure
 * later
 */
function publishReading(
  client: MqttClient,
  topic: string,
  reading: SignedTelemetry,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(reading), "utf8");
    client.publish(topic, payload, { qos: 1 }, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// you need to explain what the heck is going on here, what is this `Promises<() => Promise<void>> ` break down everything in this function
export async function runPublisher(
  config: PublisherConfig,
): Promise<() => Promise<void>> {
  console.log("[publisher] starting with configuration:");
  console.log(JSON.stringify(redactForLog(config), null, 2));

  const keyPair = await loadOrCreateKeyPair(config.keyPath);
  const client = await createMqttClient({
    brokerUrl: config.brokerUrl,
    clientId: `publisher-${config.deviceId}`,
  });
  const generator = new DataGenerator(
    config.deviceId,
    keyPair.privateKey,
    config.sensor,
  );
  const topic = rawTopicFor(config.deviceId);

  let stopped = false;
  let publishCount = 0;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const reading = generator.next();
      await publishReading(client, topic, reading);
      publishCount += 1;
      console.log(
        `[publisher] #${publishCount} ${topic} value=${reading.payload.value} ${reading.payload.unit} ` +
          `ts=${reading.payload.timestamp}`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[publisher] publish failed: ${message}`);
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, config.intervalMs);

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    await disconnectMqttClient(client);
    console.log(`[publisher] stopped after ${publishCount} publishes`);
  };

  // Fire once immediately so the first reading is not delayed by intervalMs.
  void tick();

  if (config.durationMs > 0) {
    setTimeout(() => {
      void stop();
    }, config.durationMs);
  }

  return stop;
}

/**
 * Strip nothing currently, but reserved as the single place to remove
 * credentials before printing the config. Future work: redact broker password
 * once TLS broker credentials are added.
 */
function redactForLog(config: PublisherConfig): PublisherConfig {
  return config;
}

const __filename = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  const config = loadConfig();
  runPublisher(config)
    .then((stop) => {
      const shutdown = async (): Promise<void> => {
        console.log("[publisher] shutdown signal received");
        await stop();
        process.exit(0);
      };
      process.on("SIGINT", () => {
        void shutdown();
      });
      process.on("SIGTERM", () => {
        void shutdown();
      });
    })
    .catch((err: Error) => {
      console.error(`[publisher] fatal: ${err.message}`);
      process.exit(1);
    });
}