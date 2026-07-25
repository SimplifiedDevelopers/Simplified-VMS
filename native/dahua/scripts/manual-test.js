// Standalone smoke test for the compiled addon against a real device —
// bypasses Electron/UI entirely to isolate SDK-level pass/fail.
// Usage: node scripts/manual-test.js <host> <port> <username> <password> [channel]
const path = require('path');

const [, , host, port, username, password, channel = '0'] = process.argv;
if (!host || !port || !username || !password) {
  console.error('Usage: node manual-test.js <host> <port> <username> <password> [channel]');
  process.exit(1);
}

const native = require(path.join(__dirname, '..', 'build', 'Release', 'dahua_native.node'));

let frameCount = 0;
let viewHandle = null;

try {
  console.log(`Logging in to ${host}:${port} as ${username}...`);
  const session = native.login({ host, port: Number(port), username, password });
  console.log('Login OK:', session);

  console.log(`Starting live view on channel ${channel} (main stream)...`);
  viewHandle = native.startLiveView(session.sessionId, Number(channel), 'main', (frame) => {
    frameCount += 1;
    if (frameCount === 1 || frameCount % 30 === 0) {
      console.log(
        `frame #${frameCount}: ${frame.width}x${frame.height} format=${frame.format} bytes=${frame.data.length} ts=${frame.timestampMs}`,
      );
    }
  });
  console.log('Live view started, handle:', viewHandle);

  setTimeout(() => {
    console.log(`\nReceived ${frameCount} decoded frames in 10s.`);
    if (viewHandle) native.stopLiveView(viewHandle);
    native.logout(session.sessionId);
    console.log('Stopped and logged out. Done.');
    process.exit(frameCount > 0 ? 0 : 2);
  }, 10000);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}
