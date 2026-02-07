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
  connectionReadyCallbacks.push(cb);
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

export async function connectToWhatsApp(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  const sock = makeWASocket({
    auth: state,
    logger,
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
      connectionOpen = false;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `Connection closed (status ${statusCode}). Reconnecting: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        console.log('Logged out from WhatsApp. Please delete auth_info_baileys/ and restart.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log('Connected to WhatsApp!');
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

export async function listGroups(): Promise<void> {
  await waitForConnection();
  const sock = getSocket();
  const groups = await sock.groupFetchAllParticipating();
  console.log('\n--- Groups ---');
  for (const [jid, metadata] of Object.entries(groups)) {
    console.log(`  ${metadata.subject} → ${jid}`);
  }
  console.log('--- End Groups ---\n');
}
