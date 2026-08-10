// armory-mesh — package entry.
// Re-exports the public mesh API (the tools + the core types) for programmatic use.
// pi loads src/ directly (no build step — the armory-* convention).
//
// SCAFFOLD (Phase 0). See DESIGN.md + ROADMAP.md.

export * from "./mesh.js";
export * from "./types.js";
export * from "./channels.js";
export { paths, projectDir } from "./paths.js";
export { defaultMeshConfig, type MeshConfig } from "./config.js";