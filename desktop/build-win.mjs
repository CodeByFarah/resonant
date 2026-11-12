// Builds the Windows installer: the icon, the packaged app (electron-builder, into dist/win-unpacked),
// then the setup program (Inno Setup, into dist/Resonant-Setup-<version>.exe).
// Usage: npm run dist:win   (needs Inno Setup 6: https://jrsoftware.org/isinfo.php)
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const { version } = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: here, stdio: "inherit" });

run(process.execPath, [path.join(here, "make-icon.mjs")]);
// npx is a .cmd script on Windows, which only starts through a shell; the command has no user input.
execSync("npx electron-builder --win dir --x64", { cwd: here, stdio: "inherit" });

const candidates = [
  process.env.ISCC,
  path.join(os.homedir(), "AppData", "Local", "Programs", "Inno Setup 6", "ISCC.exe"),
  "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
  "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
].filter(Boolean);
const iscc = candidates.find((p) => fs.existsSync(p));
if (!iscc) {
  console.error("Inno Setup 6 wasn't found. Install it from https://jrsoftware.org/isinfo.php, or set ISCC to the path of ISCC.exe.");
  process.exit(1);
}
run(iscc, [`/DAppVersion=${version}`, path.join(here, "installer.iss")]);
console.log(`\nInstaller: ${path.join(here, "dist", `Resonant-Setup-${version}.exe`)}`);
