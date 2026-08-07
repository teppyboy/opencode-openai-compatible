import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const getLogDir = (): string => {
  return join(homedir(), '.local', 'share', 'opencode', 'log', 'opencode-openai-compatible');
};

let logFile: string | null = null;
let initialized = false;

export async function initLogger(_client: any) {
  // Prevent multiple initialization
  if (initialized) {
    return;
  }
  initialized = true;

  // Check environment variables synchronously
  const debugEnv = process.env.OPENCODE_PLUGIN_OPENAI_COMPATIBLE_DEBUG?.toLowerCase();

  if (debugEnv !== '1' && debugEnv !== 'true') {
    return;
  }

  const LOG_DIR = getLogDir();

  // Create timestamp once for the session
  const now = new Date();
  const timeStr = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  logFile = join(LOG_DIR, `plugin-${now.toISOString().split('T')[0]}-${timeStr}.log`);

  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function log(message: string, ...args: any[]) {
  if (!logFile) {
    return;
  }

  const timestamp = new Date().toISOString();
  const formattedArgs = args.map((arg) =>
    typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
  );
  const fullMessage = `[${timestamp}] ${message} ${formattedArgs.join(' ')}\n`;

  try {
    appendFileSync(logFile, fullMessage, 'utf8');
  } catch {
    // Silently fail
  }
}
