#!/usr/bin/env node
/**
 * How close is the AI estimate to real book time? Runs the Worker's own
 * estimate code against eight common jobs on the 1985 BMW 325e and compares
 * its hours with the E30 answer key in the vault.
 *
 * The answer key (CHARM, internal only) is READ from the path you pass and
 * never copied into this public repo. Each run makes 8 billed API calls
 * (Opus 5.5 at low effort, roughly a few cents total), so run it on purpose:
 *
 *   ANTHROPIC_API_KEY=sk-... node tools/check-ai-hours.mjs \
 *     "$HOME/Documents/FGA-Brain/Cars/book-times/1985-bmw-325e-e30-labor-times.csv"
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const csvPath = process.argv[2];
if (!csvPath || !process.env.ANTHROPIC_API_KEY) {
  console.error("Usage: ANTHROPIC_API_KEY=... node tools/check-ai-hours.mjs <path to E30 labor-times CSV>");
  process.exit(1);
}

// [what the mechanic would say, component in the CSV, item in the CSV]
const CASES = [
  ["Replace water pump", "Water Pump", ""],
  ["Replace alternator", "Alternator", ""],
  ["Replace thermostat", "Thermostat", ""],
  ["Replace front brake pads", "Brake Pad", "Front"],
  ["Replace timing belt", "Timing Belt", "Belt Driven"],
  ["Replace spark plugs", "Spark Plug", ""],
  ["Replace valve cover gasket", "Valve Cover", "Belt Driven"],
  ["Replace lower radiator hose", "Radiator Hose", "Lower"],
];

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((cells) => Object.fromEntries(head.map((key, index) => [key, cells[index] ?? ""])));
}

const key = parseCsv(readFileSync(csvPath, "utf8"));
const bookHours = (component, item) => {
  const row = key.find((r) => r.component === component && r.item === item && r.operation.startsWith("Replace"));
  return row ? Number(row.standard_hours) : null;
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../sync-worker/assistant.ts", import.meta.url))],
  bundle: true, write: false, format: "esm", logLevel: "silent",
});
const { estimateTurn } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const results = [];
for (const [work, component, item] of CASES) {
  const book = bookHours(component, item);
  const reply = await estimateTurn(
    { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    { vehicle: { year: "1985", make: "BMW", model: "325e" }, work },
  );
  const ai = reply.ok ? reply.body.jobs.reduce((sum, job) => sum + job.hours, 0) : null;
  results.push({ work, book, ai, error: reply.ok ? "" : reply.body.error });
  console.log(`${work.padEnd(30)} book ${String(book ?? "?").padStart(4)}  AI ${String(ai ?? "-").padStart(4)}${reply.ok ? "" : `  (${reply.body.error})`}`);
}

const compared = results.filter((r) => r.book && r.ai);
const meanError = compared.reduce((sum, r) => sum + Math.abs(r.ai - r.book) / r.book, 0) / (compared.length || 1);
console.log(`\n${compared.length} compared · average miss ${(meanError * 100).toFixed(0)}% of book time`);
