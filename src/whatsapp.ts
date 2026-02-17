import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const logger = pino({ level: 'silent' });

let currentSock: WASocket | null = null;
let connectionOpen = false;
let connectionOpenResolvers: Array<() => void> = [];
const connectionReadyCallbacks: Array<(sock: WASocket) => void> = [];

// Connection tracking
let socketId = 0;
let connectedSince: number | null = null;
let reconnectCount = 0;

function formatUptime(since: number | null): string {
  if (!since) return 'n/a';
  const sec = Math.round((Date.now() - since) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m}m`;
}

function notifyConnectionOpen(): void {
  connectionOpen = true;
  for (const resolve of connectionOpenResolvers) {
    resolve();
  }
  connectionOpenResolvers = [];
}

export function onConnectionReady(cb: (sock: WASocket) => void): void {
  if (connectionOpen && currentSock) {
    cb(currentSock);
  } else {
    connectionReadyCallbacks.push(cb);
  }
}

export function waitForConnection(): Promise<void> {
  if (connectionOpen && currentSock) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    connectionOpenResolvers.push(resolve);
  });
}

export function waitForConnectionWithTimeout(ms: number): Promise<void> {
  if (connectionOpen && currentSock) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for WhatsApp connection (${ms}ms)`));
    }, ms);
    connectionOpenResolvers.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function getSocket(): WASocket {
  if (!currentSock) {
    throw new Error('WhatsApp socket not initialized');
  }
  return currentSock;
}

let cachedAuth: { state: Awaited<ReturnType<typeof useMultiFileAuthState>>['state']; saveCreds: () => Promise<void> } | null = null;
let reconnectDelay = 2_000;
const MAX_RECONNECT_DELAY = 60_000;

// Heartbeat: periodically verify the connection can do a server round-trip
const HEARTBEAT_INTERVAL = 12 * 60 * 1000; // 12 minutes
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function forceReconnect(reason: string): void {
  console.error(`[wa#${socketId}] ${reason}. Forcing reconnect...`);
  connectionOpen = false;
  stopHeartbeat();
  if (currentSock) {
    currentSock.ev.removeAllListeners('connection.update');
    currentSock.ev.removeAllListeners('creds.update');
    currentSock.ev.removeAllListeners('messages.upsert');
    try { currentSock.end(undefined); } catch {}
    currentSock = null;
  }
  connectToWhatsApp();
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!connectionOpen || !currentSock) {
      console.log(`[wa#${socketId}] Heartbeat skipped — not connected`);
      return;
    }

    const start = Date.now();
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 15_000)
      );
      await Promise.race([
        currentSock.fetchBlocklist(),
        timeout,
      ]);
      const latency = Date.now() - start;
      console.log(`[wa#${socketId}] Heartbeat OK (${latency}ms, uptime ${formatUptime(connectedSince)})`);
    } catch (err) {
      const latency = Date.now() - start;
      forceReconnect(`Heartbeat failed after ${latency}ms: ${err}`);
    }
  }, HEARTBEAT_INTERVAL);
}

async function getAuthState() {
  if (!cachedAuth) {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    cachedAuth = { state, saveCreds };
  }
  return cachedAuth;
}

export async function connectToWhatsApp(): Promise<void> {
  const { state, saveCreds } = await getAuthState();

  // Clean up previous socket if it exists
  if (currentSock) {
    currentSock.ev.removeAllListeners('connection.update');
    currentSock.ev.removeAllListeners('creds.update');
    currentSock.ev.removeAllListeners('messages.upsert');
    currentSock.end(undefined);
    currentSock = null;
  }

  const id = ++socketId;
  reconnectCount++;
  console.log(`[wa#${id}] Creating socket (reconnect #${reconnectCount}, backoff ${reconnectDelay}ms)`);

  const sock = makeWASocket({
    auth: state,
    logger,
    keepAliveIntervalMs: 45_000,
    connectTimeoutMs: 30_000,
    defaultQueryTimeoutMs: 120_000,
    retryRequestDelayMs: 500,
    markOnlineOnConnect: false,
  });

  currentSock = sock;
  connectionOpen = false;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const uptime = formatUptime(connectedSince);
      connectionOpen = false;
      connectedSince = null;
      stopHeartbeat();

      const boomErr = lastDisconnect?.error as Boom | undefined;
      const statusCode = boomErr?.output?.statusCode;
      const errorMsg = boomErr?.message ?? 'unknown';
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[wa#${id}] Connection closed: status=${statusCode} error="${errorMsg}" uptime=${uptime}. ` +
        (shouldReconnect ? `Reconnecting in ${reconnectDelay / 1000}s...` : 'Not reconnecting (logged out).')
      );

      if (shouldReconnect) {
        setTimeout(() => connectToWhatsApp(), reconnectDelay);
        // Exponential backoff: 2s → 4s → 8s → 16s → 32s → 60s max
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      } else {
        console.log('Logged out from WhatsApp. Please delete auth_info_baileys/ and restart.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      connectedSince = Date.now();
      reconnectCount = 0;
      reconnectDelay = 2_000; // Reset backoff on successful connection
      console.log(`[wa#${id}] Connected to WhatsApp`);
      startHeartbeat();
      notifyConnectionOpen();
      for (const cb of connectionReadyCallbacks) {
        cb(sock);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Wait for this specific connection attempt to open
  await waitForConnection();
}

export async function sendGroupMessage(
  groupJid: string,
  text: string
): Promise<void> {
  await waitForConnection();
  const sock = getSocket();
  await sock.sendMessage(groupJid, { text });
}

export async function listGroups(): Promise<Record<string, string>> {
  await waitForConnection();
  const sock = getSocket();
  const groups = await sock.groupFetchAllParticipating();
  const result: Record<string, string> = {};
  console.log('\n--- Groups ---');
  for (const [jid, metadata] of Object.entries(groups)) {
    console.log(`  ${metadata.subject} → ${jid}`);
    result[jid] = metadata.subject;
  }
  console.log('--- End Groups ---\n');
  return result;
}
