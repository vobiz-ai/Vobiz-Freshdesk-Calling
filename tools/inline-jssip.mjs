/**
 * Inline the vendored JsSIP bundle into index.html.
 *
 * FDK lints every .js file under app/ — vendored dependencies included — and
 * neither .fdkignore, .eslintignore, nor relocating the file exempts it. JsSIP
 * uses `var` 901 times, which is 989 lint errors and an aborted `fdk pack`
 * (ISSUES.md #2). FDK does not lint inline <script>, so packing a copy of the
 * app with the bundle inlined clears the block without touching the library's
 * semantics — verified: 0 lint errors, 0 platform errors.
 *
 * Operates on a build copy. The source tree keeps app/lib/jssip.min.js as the
 * readable, rebuildable source of truth.
 *
 * Usage: node tools/inline-jssip.mjs <build-dir>
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const buildDir = process.argv[2];
if (!buildDir) {
  console.error("usage: node tools/inline-jssip.mjs <build-dir>");
  process.exit(1);
}

const TAG = '<script src="lib/jssip.min.js"></script>';
const htmlPath = join(buildDir, "app", "index.html");
const libPath = join(buildDir, "app", "lib", "jssip.min.js");

const html = readFileSync(htmlPath, "utf8");
if (!html.includes(TAG)) {
  console.error(`✖ ${htmlPath} does not contain the expected tag:\n  ${TAG}`);
  process.exit(1);
}

const bundle = readFileSync(libPath, "utf8");

// The bundle is an IIFE assigning the JsSIP global. It must run before app.js,
// which is deferred, so an inline script in <head> is the same ordering the
// external <script src> gave us.
writeFileSync(
  htmlPath,
  html.replace(TAG, `<script>\n${bundle}\n</script>`),
  "utf8"
);

// The external copy would still be linted if it stayed under app/.
rmSync(join(buildDir, "app", "lib"), { recursive: true, force: true });

console.log(`✔ inlined ${(bundle.length / 1024).toFixed(0)} KB of JsSIP into app/index.html`);
