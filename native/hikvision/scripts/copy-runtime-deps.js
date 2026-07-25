// HCNetSDK.dll dynamically loads its own plugin DLLs from a folder named
// "HCNetSDKCom" next to itself at runtime (not the normal Windows DLL search
// path) — both the top-level SDK DLLs and that subfolder must sit next to
// the compiled .node file or every login/preview call fails at runtime.
const fs = require('fs');
const path = require('path');

const sdkDir = process.env.HIK_SDK_DIR;
if (!sdkDir) {
  console.error('HIK_SDK_DIR is not set — skipping Hikvision runtime DLL copy.');
  process.exit(1);
}

const libDir = path.join(sdkDir, 'lib');
const outDir = path.join(__dirname, '..', 'build', 'Release');

if (!fs.existsSync(outDir)) {
  console.error(`Build output dir not found: ${outDir} — run node-gyp rebuild first.`);
  process.exit(1);
}

const entries = fs.readdirSync(libDir, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
    fs.copyFileSync(path.join(libDir, entry.name), path.join(outDir, entry.name));
    console.log(`copied ${entry.name}`);
  }
}

const comSrc = path.join(libDir, 'HCNetSDKCom');
const comDest = path.join(outDir, 'HCNetSDKCom');
if (fs.existsSync(comSrc)) {
  fs.cpSync(comSrc, comDest, { recursive: true });
  console.log('copied HCNetSDKCom/');
}

console.log('Hikvision runtime dependencies copied to', outDir);
