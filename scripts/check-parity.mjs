/**
 * Prove the TypeScript engine and the Python CLI write the same drafts.
 *
 * src/lib/drafts.ts is the source of truth for wording. tools/lead_followup_drafter.py
 * mirrors it, and a mirror is only worth having if something checks it, so this
 * script runs both over public/sample_leads.csv and compares the results field by
 * field. It exits non-zero on the first difference, with the field and both values
 * printed, so a drifting template is a build failure rather than a surprise in
 * front of a customer.
 *
 * Run it with `npm run parity`. It needs python3 on PATH; if there is none it says
 * so and exits non-zero rather than quietly passing.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SAMPLE_CSV = join(ROOT, "public", "sample_leads.csv");
const PYTHON_CLI = join(ROOT, "tools", "lead_followup_drafter.py");

/** Print a failure and stop. */
function fail(message) {
  console.error(`Parity check failed: ${message}`);
  process.exit(1);
}

/**
 * Compile the TypeScript engine to a temporary directory and import it.
 *
 * tsc leaves import specifiers alone, so the emitted `from "./drafts"` has to be
 * rewritten to `from "./drafts.js"` before Node's ESM loader will resolve it.
 */
async function loadTypeScriptEngine(outDir) {
  execFileSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "typescript", "bin", "tsc"),
      join(ROOT, "src", "lib", "drafts.ts"),
      join(ROOT, "src", "lib", "csv.ts"),
      "--outDir",
      outDir,
      "--module",
      "es2022",
      "--target",
      "es2022",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
    ],
    { cwd: ROOT, stdio: "inherit" },
  );

  for (const file of readdirSync(outDir)) {
    if (!file.endsWith(".js")) continue;
    const path = join(outDir, file);
    const patched = readFileSync(path, "utf8").replace(
      /from ["']\.\/([A-Za-z0-9_-]+)["']/g,
      'from "./$1.js"',
    );
    writeFileSync(path, patched);
  }

  const drafts = await import(pathToFileURL(join(outDir, "drafts.js")).href);
  const csv = await import(pathToFileURL(join(outDir, "csv.js")).href);
  return { drafts, csv };
}

/** Run the Python CLI and return its JSON output. */
function loadPythonDrafts() {
  let raw;
  try {
    raw = execFileSync("python3", [PYTHON_CLI, "--csv", SAMPLE_CSV, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (error) {
    fail(`could not run the Python CLI (${error.message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`the Python CLI did not print valid JSON (${error.message})`);
  }
}

/** Show a mismatch with the exact characters that differ. */
function describe(value) {
  return JSON.stringify(value);
}

// Emitted inside the project so the compiled csv.js can still resolve papaparse
// from node_modules; a system temp directory cannot see it.
const cacheRoot = join(ROOT, "node_modules", ".cache");
mkdirSync(cacheRoot, { recursive: true });
const outDir = mkdtempSync(join(cacheRoot, "lead-followup-parity-"));
try {
  const { drafts: engine, csv } = await loadTypeScriptEngine(outDir);
  const { leads } = csv.parseLeads(readFileSync(SAMPLE_CSV, "utf8"));
  const tsDrafts = engine.buildDrafts(leads, engine.DEMO_BUSINESS);
  const pyDrafts = loadPythonDrafts();

  if (tsDrafts.length !== pyDrafts.length) {
    fail(`TypeScript produced ${tsDrafts.length} drafts, Python produced ${pyDrafts.length}`);
  }

  const leadFields = [
    "name",
    "phone",
    "email",
    "projectType",
    "city",
    "timeline",
    "details",
    "source",
    "submittedAt",
  ];
  const draftFields = ["isUrgent", "sms", "smsLength", "smsOverLimit", "subject", "body"];

  for (let i = 0; i < tsDrafts.length; i += 1) {
    const ts = tsDrafts[i];
    const py = pyDrafts[i];
    for (const field of leadFields) {
      if (ts.lead[field] !== py.lead[field]) {
        fail(
          `draft ${i + 1}, lead.${field}\n  TypeScript: ${describe(ts.lead[field])}\n  Python:     ${describe(py.lead[field])}`,
        );
      }
    }
    for (const field of draftFields) {
      if (ts[field] !== py[field]) {
        fail(
          `draft ${i + 1} (${ts.lead.name}), ${field}\n  TypeScript: ${describe(ts[field])}\n  Python:     ${describe(py[field])}`,
        );
      }
    }
  }

  const urgent = tsDrafts.filter((d) => d.isUrgent).length;
  console.log(
    `Parity OK: ${tsDrafts.length} drafts identical in TypeScript and Python (${urgent} urgent).`,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
