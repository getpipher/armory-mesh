// armory-mesh — Phase 8 smoke: the project-scoped mesh config (.pi/mesh.json ancestor discovery).
//   1. A mesh.json at a workspace root is found from DEEP child folders (the bug-bounty fleet case:
//      one bucket-level file, every hunt folder joins the same pool).
//   2. Malformed mesh.json files are skipped (the walk continues; no crash).
//   3. No mesh.json anywhere up the tree → null (cwd-basename fallback applies in the extension).
// Run: `pnpm test:smoke8` (jiti).

import { findMeshConfig } from "../extensions/mesh.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "meshcfg-smoke-"));
try {
  console.log("armory-mesh — Phase 8 smoke test\n");

  // 1. Deep discovery.
  fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "mesh.json"), JSON.stringify({ project: "fleet-x", persistChannels: ["#dup-check", "#handoff"] }));
  const deep = path.join(root, "hunts", "some-target", "repos", "pkg");
  fs.mkdirSync(deep, { recursive: true });
  const hit = findMeshConfig(deep);
  check("mesh.json found from a deep child folder", hit?.project === "fleet-x");
  check("persistChannels parsed as strings", Array.isArray(hit?.persistChannels) && hit?.persistChannels.length === 2);

  // 2. A malformed closer mesh.json is skipped in favor of nothing-closer (walk continues upward).
  const mid = path.join(root, "hunts", "some-target");
  fs.mkdirSync(path.join(mid, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(mid, ".pi", "mesh.json"), "{not json");
  const fromDeep = findMeshConfig(deep);
  check("malformed closer mesh.json is skipped (root file still wins)", fromDeep?.project === "fleet-x");

  // 3. No file up the tree → null.
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), "meshcfg-none-"));
  try {
    check("no mesh.json up the tree → null", findMeshConfig(clean) === null);
  } finally {
    fs.rmSync(clean, { recursive: true, force: true });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("");
if (failures === 0) { console.log("✅ Phase 8 smoke test PASSED (all criteria)"); process.exit(0); }
else { console.error(`❌ Phase 8 smoke test FAILED (${failures} check(s))`); process.exit(1); }