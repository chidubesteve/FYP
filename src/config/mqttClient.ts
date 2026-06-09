/**
 * mqttClient.ts
 *
 * Centralised MQTT broker connection helper for TrustFlow-DT.
 *
 * All MQTT-using modules (publisher, subscriber, oracle, digital twin core)
 * obtain their client through this factory so that broker URL, credentials,
 * keepalive and reconnection behaviour are configured in exactly one place.
 *
 * Reference: Mishra and Kertesz (2020) on MQTT broker tuning; Mosquitto
 * documentation for QoS and persistent session semantics.
 */

import mqtt from "mqtt";
import { randomUUID } from "crypto";

/**
 * Options accepted by createMqttClient. Every field is optional so the helper
 * can be called with no arguments during local development against the default
 * Mosquitto instance on localhost:1883.
 */

export interface MqttClientOptions {
  brokerUrl?: string; // e.g. "mqtt://localhost:1883"
  username?: string;
  password?: string;
  clientId?: string; // defaults to random UUID
  keepalive?: number; // seconds between pings to broker, default 60s
  /**
   * If true, the broker discards any previous session for this clientId on
   * connect. We default to false so that QoS 1 messages queued for the client
   * during a brief disconnect are still delivered on reconnect.
   */
  clean?: boolean;
  reconnectPeriod?: number; // ms between reconnection attempts, default 1000ms
  connectTimeout?: number; // ms before a connect attempt times out, default 30s
}

const DEFAULT_OPTIONS: Required<
  Omit<MqttClientOptions, "clientId" | "username" | "password">
> = {
  brokerUrl: "mqtt://localhost:1883",
  keepalive: 60,
  clean: false,
  reconnectPeriod: 2000,
  connectTimeout: 10_000,
};

/**
 * Create an MQTT client and return it once the initial connection succeeds.
 *
 * The returned promise rejects if the broker is unreachable within
 * connectTimeout. Once connected, the client emits 'reconnect', 'offline' and
 * 'error' events which are logged here so that downstream code does not have
 * to wire identical listeners in every module.
 *
 * @param options Partial overrides for the defaults shown above.
 * @returns A connected MqttClient instance.
 */
export function createMqttClient(
  options: MqttClientOptions = {},
): Promise<mqtt.MqttClient> {
  const clientId = options.clientId ?? `trustflow-${randomUUID()}`;
  const brokerUrl = options.brokerUrl ?? DEFAULT_OPTIONS.brokerUrl;

  // where does IClientOptions come from? what is it doing here? why do we need to create this object here? what are these options doing?
  const connectOptions: mqtt.IClientOptions = {
    clientId,
    keepalive: options.keepalive ?? DEFAULT_OPTIONS.keepalive,
    clean: options.clean ?? DEFAULT_OPTIONS.clean,
    reconnectPeriod: options.reconnectPeriod ?? DEFAULT_OPTIONS.reconnectPeriod,
    connectTimeout: options.connectTimeout ?? DEFAULT_OPTIONS.connectTimeout,
  };

  if (options.username !== undefined && options.password !== undefined) {
    ((connectOptions.username = options.username),
      (connectOptions.password = options.password));
  }

  return new Promise((resolve, reject) => {
    const client = mqtt.connect(brokerUrl, connectOptions);

    // why do we need this bit? wht attach, what does the resolve do? why do we need to remove the listeners here? what is going on with the listeners here?
    const onInitialConnect = () => {
      client.removeListener("error", onInitialError);
      console.log(
        `MQTT client ${clientId} connected to broker at ${brokerUrl}`,
      );
      attachLifecycleListeners(client, clientId, brokerUrl);
      resolve(client);
    };
    // why do we need this bit too?
    // wht is going on with the listeners here? why do we need to remove them?
    const onInitialError = (err: Error) => {
      client.removeListener("connect", onInitialConnect);
      client.end();
      reject(
        new Error(
          `Failed to connect MQTT client ${clientId} to broker at ${brokerUrl}: ${err.message}`,
        ),
      );
    };
    // what does the once do?
    client.once("connect", onInitialConnect);
    client.once("error", onInitialError);
  });
}
// what are lifecycle listeners? why do we need them? what are they doing here? why do we need to attach them here?
function attachLifecycleListeners(
  client: mqtt.MqttClient,
  clientId: string,
  brokerUrl: string,
): void {
  client.on("reconnect", () => {
    console.warn(
      `MQTT client ${clientId} attempting to reconnect to broker at ${brokerUrl}...`,
    );
  });
  client.on("offline", () => {
    console.warn(
      `MQTT client ${clientId} went offline (disconnected from broker at ${brokerUrl})`,
    );
  });
  client.on("error", (err) => {
    console.error(
      `MQTT client ${clientId} encountered error with broker at ${brokerUrl}: ${err.message}`,
    );
  });
  client.on("close", () => {
    console.warn(
      `MQTT client ${clientId} connection to broker at ${brokerUrl} closed`,
    );
  });
}

/**
 * Cleanly disconnect a client. Wraps the callback-based mqtt.js end() in a
 * promise so callers can await graceful shutdown in tests and CLI tools.
 */
export async function disconnectMqttClient(
  client: mqtt.MqttClient,
): Promise<void> {
  return new Promise((resolve) => {
    client.end(false, {}, () => {
      console.log(
        `MQTT client ${client.options.clientId} disconnected from broker`,
      );
      resolve();
    });
  });
}
