#!/usr/bin/env node
/**
 * Shipbox Realtime CLI
 *
 * Connect to a session's realtime WebSocket stream and display events.
 *
 * Usage:
 *   ./realtime-cli.mjs <sessionId> [--token <token>]
 *   ./realtime-cli.mjs eacb9bde
 *   ./realtime-cli.mjs eacb9bde --token eyJ...
 */

import WebSocket from 'ws';

const BASE_URL = process.env.SHIPBOX_URL || 'wss://engine.shipbox.dev';
const API_URL = process.env.SHIPBOX_API_URL || 'https://engine.shipbox.dev';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

function color(c, text) {
  return `${colors[c]}${text}${colors.reset}`;
}

function timestamp() {
  return color('gray', new Date().toLocaleTimeString());
}

function parseArgs(args) {
  const result = { sessionId: null, token: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' || args[i] === '-t') {
      result.token = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else if (!args[i].startsWith('-')) {
      result.sessionId = args[i];
    }
  }

  return result;
}

function printHelp() {
  console.log(`
${color('bold', 'Shipbox Realtime CLI')}

Connect to a session's realtime WebSocket stream and display events.

${color('bold', 'Usage:')}
  realtime-cli <sessionId> [options]

${color('bold', 'Options:')}
  --token, -t <token>  Realtime token (fetched automatically if not provided)
  --help, -h           Show this help message

${color('bold', 'Examples:')}
  realtime-cli eacb9bde
  realtime-cli eacb9bde --token eyJ...

${color('bold', 'Environment Variables:')}
  SHIPBOX_URL      WebSocket base URL (default: wss://engine.shipbox.dev)
  SHIPBOX_API_URL  API base URL (default: https://engine.shipbox.dev)
`);
}

async function fetchToken(sessionId) {
  console.log(color('dim', `Fetching token for session ${sessionId}...`));

  try {
    const response = await fetch(`${API_URL}/internal/sessions/${sessionId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch session: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.realtimeToken) {
      throw new Error('No realtime token in response');
    }
    return data.realtimeToken;
  } catch (error) {
    console.error(color('red', `Error fetching token: ${error.message}`));
    process.exit(1);
  }
}

function formatEvent(event) {
  const type = event.type || 'unknown';
  const data = event.data || event;

  // Color based on event type
  let typeColor = 'cyan';
  let icon = '●';

  if (type.includes('started')) {
    typeColor = 'blue';
    icon = '▶';
  } else if (type.includes('completed')) {
    typeColor = 'green';
    icon = '✓';
  } else if (type.includes('failed') || type.includes('error')) {
    typeColor = 'red';
    icon = '✗';
  } else if (type.includes('progress') || type.includes('running')) {
    typeColor = 'yellow';
    icon = '◐';
  }

  return { type, data, typeColor, icon };
}

function printEvent(event) {
  const { type, data, typeColor, icon } = formatEvent(event);

  console.log(`${timestamp()} ${color(typeColor, icon)} ${color('bold', type)}`);

  // Print relevant data fields
  if (data.taskId) {
    console.log(`  ${color('dim', 'taskId:')} ${data.taskId}`);
  }
  if (data.runId) {
    console.log(`  ${color('dim', 'runId:')} ${data.runId}`);
  }
  if (data.model) {
    console.log(`  ${color('dim', 'model:')} ${data.model}`);
  }
  if (data.error) {
    console.log(`  ${color('red', 'error:')} ${data.error}`);
  }
  if (data.outputPreview) {
    const preview = data.outputPreview.slice(0, 200).replace(/\n/g, ' ');
    console.log(`  ${color('dim', 'output:')} ${preview}${data.outputPreview.length > 200 ? '...' : ''}`);
  }
  if (data.tokens) {
    const { input, output, reasoning } = data.tokens;
    console.log(`  ${color('dim', 'tokens:')} in=${input || 0} out=${output || 0} reasoning=${reasoning || 0}`);
  }
  if (data.message) {
    console.log(`  ${color('dim', 'message:')} ${data.message}`);
  }

  console.log('');
}

function connect(sessionId, token) {
  const wsUrl = `${BASE_URL}/realtime?sessionId=${sessionId}&token=${token}`;

  console.log(color('dim', `Connecting to ${sessionId}...`));
  console.log('');

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`${timestamp()} ${color('green', '●')} ${color('bold', 'Connected')}`);
    console.log(`  ${color('dim', 'session:')} ${sessionId}`);
    console.log(`  ${color('dim', 'url:')} ${BASE_URL}`);
    console.log('');
    console.log(color('dim', '─'.repeat(60)));
    console.log('');
  });

  ws.on('message', (data) => {
    const message = data.toString();

    // Handle ping/pong
    if (message === 'ping') {
      ws.send('pong');
      return;
    }

    // Parse and display event
    try {
      const event = JSON.parse(message);
      printEvent(event);
      // oxlint-disable-next-line eslint/no-unused-vars
    } catch (_e) {
      // Non-JSON message
      console.log(`${timestamp()} ${color('gray', 'raw:')} ${message.slice(0, 100)}`);
    }
  });

  ws.on('close', (code, reason) => {
    console.log('');
    console.log(`${timestamp()} ${color('yellow', '●')} ${color('bold', 'Disconnected')}`);
    console.log(`  ${color('dim', 'code:')} ${code}`);
    if (reason) {
      console.log(`  ${color('dim', 'reason:')} ${reason}`);
    }
    process.exit(0);
  });

  ws.on('error', (error) => {
    console.error(`${timestamp()} ${color('red', '✗')} ${color('bold', 'Error')}`);
    console.error(`  ${error.message}`);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('');
    console.log(color('dim', 'Closing connection...'));
    ws.close();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.sessionId) {
    console.error(color('red', 'Error: Session ID is required'));
    console.error('');
    printHelp();
    process.exit(1);
  }

  // Validate session ID format (8 hex chars)
  if (!/^[0-9a-f]{8}$/.test(args.sessionId)) {
    console.error(color('red', `Error: Invalid session ID format: ${args.sessionId}`));
    console.error(color('dim', 'Session ID should be 8 hexadecimal characters (e.g., eacb9bde)'));
    process.exit(1);
  }

  console.log('');
  console.log(color('bold', '  Shipbox Realtime CLI'));
  console.log('');

  // Fetch token if not provided
  const token = args.token || await fetchToken(args.sessionId);

  // Connect to WebSocket
  connect(args.sessionId, token);
}

main().catch((error) => {
  console.error(color('red', `Fatal error: ${error.message}`));
  process.exit(1);
});
