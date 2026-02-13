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

export function getSocket(): WASocket {
  if (!currentSock) {
    throw new Error('WhatsApp socket not initialized');
  }
  return currentSock;
}

let cachedAuth: { state: Awaited<ReturnType<typeof useMultiFileAuthState>>['state']; saveCreds: () => Promise<void> } | null = null;
let reconnectDelay = 2_000;
const MAX_RECONNECT_DELAY = 60_000;

// Heartbeat: periodically check connection health and message flow
const HEARTBEAT_INTERVAL = 12 * 60 * 1000; // 12 minutes
const MESSAGE_STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes without message events = stale
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageEventAt = Date.now();

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function forceReconnect(reason: string): void {
  console.error(`[heartbeat] ${reason}. Forcing reconnect...`);
  connectionOpen = false;
  stopHeartbeat();
  try { currentSock?.end(undefined); } catch {}
  connectToWhatsApp();
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!connectionOpen || !currentSock) {
      console.log('[heartbeat] Skipping — not connected');
      return;
    }

    // Check 1: Has the message stream gone silent?
    const silentMinutes = Math.round((Date.now() - lastMessageEventAt) / 60_000);
    if (Date.now() - lastMessageEventAt > MESSAGE_STALE_THRESHOLD) {
      forceReconnect(`No message events for ${silentMinutes}min — stream appears dead`);
      return;
    }

    // Check 2: Can we do a server round-trip? (fetchBlocklist requires a response)
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), 15_000)
      );
      await Promise.race([
        currentSock.fetchBlocklist(),
        timeout,
      ]);
      console.log(`[heartbeat] Connection alive (last msg event ${silentMinutes}min ago)`);
    } catch (err) {
      forceReconnect(`Server query failed (${err})`);
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

  // Track message event activity for staleness detection
  sock.ev.on('messages.upsert', () => {
    lastMessageEventAt = Date.now();
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      connectionOpen = false;
      stopHeartbeat();
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `Connection closed (status ${statusCode}). Reconnecting in ${reconnectDelay / 1000}s...`
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
      console.log('Connected to WhatsApp!');
      reconnectDelay = 2_000; // Reset backoff on successful connection
      lastMessageEventAt = Date.now(); // Reset so we don't immediately trigger staleness
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
