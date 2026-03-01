/**
 * Symlinks (or copies) this plugin into an Obsidian vault for local development.
 *
 * Resolution order for vault path:
 *   1. CLI argument:          bun scripts/link-dev.ts <vault-path>
 *   2. Environment variable:  OBSIDIAN_VAULT=<path>
 *   3. Auto-detect:           reads Obsidian's config to find the currently open vault
 *
 * The script:
 *   1. Resolves the vault's plugin directory (<vault>/.obsidian/plugins/<plugin-id>)
 *   2. Removes any existing install (symlink, directory, or file) at that path
 *   3. Creates a symlink from the plugin dir to this project root
 *   4. Falls back to a recursive copy if symlinking fails (e.g. on FAT/exFAT volumes)
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname);

function readPluginId(): string {
  const manifestPath = join(projectRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (!manifest.id || typeof manifest.id !== "string") {
    throw new Error(`manifest.json is missing a valid "id" field`);
  }
  return manifest.id;
}

/**
 * Locate Obsidian's global config file (obsidian.json) which lists all known vaults.
 * Path varies by platform:
 *   macOS:   ~/Library/Application Support/obsidian/obsidian.json
 *   Linux:   ~/.config/obsidian/obsidian.json
 *   Windows: %APPDATA%/obsidian/obsidian.json
 */
function getObsidianConfigPath(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
    case "win32":
      return join(
        process.env.APPDATA || join(home, "AppData", "Roaming"),
        "obsidian",
        "obsidian.json",
      );
    default:
      return join(
        process.env.XDG_CONFIG_HOME || join(home, ".config"),
        "obsidian",
        "obsidian.json",
      );
  }
}

interface ObsidianVaultEntry {
  path: string;
  ts?: number;
  open?: boolean;
}

/**
 * Auto-detect vault path from Obsidian's config.
 * Prefers the vault marked `open: true`. Falls back to most-recently-used if none is open.
 * Fails if no vaults are found.
 */
function autoDetectVault(): string {
  const configPath = getObsidianConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(
      `Obsidian config not found at ${configPath}\n` +
        "Specify vault path explicitly: bun scripts/link-dev.ts <vault-path>",
    );
  }

  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const vaults: Record<string, ObsidianVaultEntry> = config.vaults || {};
  const entries = Object.values(vaults).filter((v) => existsSync(v.path));

  if (entries.length === 0) {
    throw new Error("No Obsidian vaults found. Specify vault path explicitly.");
  }

  // Prefer the currently open vault
  const openVault = entries.find((v) => v.open);
  if (openVault) return openVault.path;

  // Fall back to most recently used
  entries.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return entries[0].path;
}

function resolveVaultPath(): string {
  const explicit = process.argv[2] || process.env.OBSIDIAN_VAULT;

  if (explicit) {
    const vaultPath = resolve(explicit);
    if (!existsSync(vaultPath)) {
      console.error(`Vault path does not exist: ${vaultPath}`);
      process.exit(1);
    }
    const dotObsidian = join(vaultPath, ".obsidian");
    if (!existsSync(dotObsidian)) {
      console.error(`Not an Obsidian vault (missing .obsidian/): ${vaultPath}`);
      process.exit(1);
    }
    return vaultPath;
  }

  return autoDetectVault();
}

function removeExisting(targetPath: string): void {
  if (!existsSync(targetPath) && !lstatExists(targetPath)) return;

  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    console.log(`Removing existing symlink: ${targetPath}`);
    rmSync(targetPath);
  } else if (stat.isDirectory()) {
    console.log(`Removing existing directory: ${targetPath}`);
    rmSync(targetPath, { recursive: true });
  } else {
    console.log(`Removing existing file: ${targetPath}`);
    rmSync(targetPath);
  }
}

/** lstatSync that doesn't throw on ENOENT — needed for dangling symlinks */
function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const pluginId = readPluginId();
  const vaultPath = resolveVaultPath();
  const pluginsDir = join(vaultPath, ".obsidian", "plugins");
  const targetPath = join(pluginsDir, pluginId);

  console.log(`Vault: ${vaultPath}`);

  // Ensure .obsidian/plugins/ exists
  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  removeExisting(targetPath);

  // Try symlink first, fall back to copy
  try {
    symlinkSync(projectRoot, targetPath, "dir");
    console.log(`Symlinked: ${targetPath} -> ${projectRoot}`);
  } catch (symlinkErr) {
    console.warn(
      `Symlink failed (${(symlinkErr as NodeJS.ErrnoException).code}), falling back to copy...`,
    );
    try {
      cpSync(projectRoot, targetPath, {
        recursive: true,
        filter: (src) => {
          const rel = src.slice(projectRoot.length + 1);
          return !rel.startsWith("node_modules") && !rel.startsWith(".git");
        },
      });
      console.log(`Copied: ${projectRoot} -> ${targetPath}`);
      console.warn("Note: Using copy mode. Re-run after each build to update the plugin.");
    } catch (copyErr) {
      console.error("Copy also failed:", copyErr);
      process.exit(1);
    }
  }
}

main();
