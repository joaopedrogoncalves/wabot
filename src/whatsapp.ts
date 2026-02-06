import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

const logger = pino({ level: 'silent' });

export async function connectToWhatsApp(): Promise<WASocket> {
  return new Promise(async (resolve) => {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: true,
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `Connection closed (status ${statusCode}). Reconnecting: ${shouldReconnect}`
        );

        if (shouldReconnect) {
          connectToWhatsApp().then(resolve);
        } else {
          console.log('Logged out from WhatsApp. Please delete auth_info_baileys/ and restart.');
          process.exit(1);
        }
      }

      if (connection === 'open') {
        console.log('Connected to WhatsApp!');
        resolve(sock);
      }
    });

    sock.ev.on('creds.update', saveCreds);
  });
}

export async function sendGroupMessage(
  sock: WASocket,
  groupJid: string,
  text: string
): Promise<void> {
  await sock.sendMessage(groupJid, { text });
}

export async function listGroups(sock: WASocket): Promise<void> {
  const groups = await sock.groupFetchAllParticipating();
  console.log('\n--- Groups ---');
  for (const [jid, metadata] of Object.entries(groups)) {
    console.log(`  ${metadata.subject} → ${jid}`);
  }
  console.log('--- End Groups ---\n');
}
