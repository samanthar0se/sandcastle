/**
 * SessionStore — keyed collection of agent session JSONLs.
 *
 * Provides read/write access to Claude Code session files, with two
 * implementations: host-backed (filesystem) and sandbox-backed (via
 * bind-mount handle file-transfer primitives). The `transferSession`
 * function copies a session between stores, rewriting `cwd` fields in
 * the JSONL entries from source cwd to target cwd.
 */

import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

// ---------------------------------------------------------------------------
// SessionStore interface
// ---------------------------------------------------------------------------

/** A keyed collection of agent session JSONLs associated with a cwd. */
export interface SessionStore {
  /** The working directory this store is associated with. */
  readonly cwd: string;
  /** Whether a session exists in this store. */
  exists(id: string): Promise<boolean>;
  /** Absolute path where a session is stored, when the store is file-backed and locatable. */
  sessionFilePath(id: string): string | undefined;
  /** Read a session's JSONL content by ID. Throws if not found. */
  readSession(id: string): Promise<string>;
  /** Write a session's JSONL content by ID. Creates or overwrites. */
  writeSession(id: string, content: string): Promise<void>;
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Path encoding
// ---------------------------------------------------------------------------

/**
 * Encode a cwd into the Claude Code `~/.claude/projects/<encoded>/` layout.
 * Replaces path separators with hyphens, matching Claude Code's convention.
 */
export const encodeProjectPath = (cwd: string): string => {
  const isRoot = cwd === "/" || /^[A-Za-z]:[\\/]?$/.test(cwd);
  const normalized = isRoot ? cwd : cwd.replace(/[\\/]+$/, "");
  return normalized.replace(/^([A-Za-z]):/, "$1").replace(/[\\/]/g, "-");
};

// ---------------------------------------------------------------------------
// Host-backed SessionStore
// ---------------------------------------------------------------------------

/**
 * Create a host-backed SessionStore that reads/writes session JSONLs on the
 * host filesystem using Claude Code's `~/.claude/projects/<encoded>/` layout.
 *
 * @param cwd - The host repo directory this store is associated with.
 * @param projectsDir - Override for the projects directory (default: `~/.claude/projects`).
 */
export const hostSessionStore = (
  cwd: string,
  projectsDir?: string,
): SessionStore => {
  const baseDir =
    projectsDir ?? join(process.env.HOME ?? "~", ".claude", "projects");
  const encoded = encodeProjectPath(cwd);
  const projectDir = join(baseDir, encoded);

  return {
    cwd,
    sessionFilePath: (id: string): string => join(projectDir, `${id}.jsonl`),
    exists: async (id: string): Promise<boolean> =>
      pathExists(join(projectDir, `${id}.jsonl`)),
    readSession: async (id: string): Promise<string> => {
      return await readFile(join(projectDir, `${id}.jsonl`), "utf-8");
    },
    writeSession: async (id: string, content: string): Promise<void> => {
      await mkdir(projectDir, { recursive: true });
      await writeFile(join(projectDir, `${id}.jsonl`), content);
    },
  };
};

// ---------------------------------------------------------------------------
// Sandbox-backed SessionStore
// ---------------------------------------------------------------------------

/**
 * Create a sandbox-backed SessionStore that uses a bind-mount handle's
 * `copyFileIn`/`copyFileOut` to transfer session files.
 *
 * @param cwd - The sandbox-side working directory.
 * @param handle - The bind-mount sandbox handle for file transfer.
 * @param projectsDir - The sandbox-side path to `~/.claude/projects`.
 */
export const sandboxSessionStore = (
  cwd: string,
  handle: Pick<BindMountSandboxHandle, "copyFileIn" | "copyFileOut" | "exec">,
  projectsDir: string,
): SessionStore => {
  const encoded = encodeProjectPath(cwd);
  // Sandbox-side paths target a Linux container, so they must use POSIX
  // separators regardless of host platform — platform-aware `join` produces
  // backslashes on Windows hosts, which the container daemon rejects.
  const projectDir = posix.join(projectsDir, encoded);

  return {
    cwd,
    sessionFilePath: (id: string): string =>
      posix.join(projectDir, `${id}.jsonl`),
    exists: async (id: string): Promise<boolean> => {
      const result = await handle.exec(
        `test -f ${JSON.stringify(posix.join(projectDir, `${id}.jsonl`))}`,
      );
      return result.exitCode === 0;
    },
    readSession: async (id: string): Promise<string> => {
      const sandboxPath = posix.join(projectDir, `${id}.jsonl`);
      const tmpPath = join(
        tmpdir(),
        `sandcastle-session-${id}-${Date.now()}.jsonl`,
      );
      await handle.copyFileOut(sandboxPath, tmpPath);
      try {
        return await readFile(tmpPath, "utf-8");
      } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    },
    writeSession: async (id: string, content: string): Promise<void> => {
      const sandboxPath = posix.join(projectDir, `${id}.jsonl`);
      const tmpPath = join(
        tmpdir(),
        `sandcastle-session-${id}-${Date.now()}.jsonl`,
      );
      await writeFile(tmpPath, content);
      try {
        // Ensure the sandbox-side project directory exists — `docker cp` /
        // `podman cp` require the destination's parent directory to exist.
        await handle.exec(`mkdir -p ${JSON.stringify(projectDir)}`);
        await handle.copyFileIn(tmpPath, sandboxPath);
      } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    },
  };
};

export const transferClaudeSession = async (
  from: SessionStore,
  to: SessionStore,
  id: string,
): Promise<void> => transferSession(from, to, id);

// ---------------------------------------------------------------------------
// Codex session stores
// ---------------------------------------------------------------------------

interface LocatableSessionStore extends SessionStore {
  locateSession(id: string): Promise<{ path: string; relativePath: string }>;
  writeSessionAt(relativePath: string, content: string): Promise<void>;
}

const isCodexSessionFilename = (filename: string, id: string): boolean =>
  filename.startsWith("rollout-") && filename.endsWith(`-${id}.jsonl`);

const codexIdFromFilename = (filename: string): string | undefined => {
  const match =
    /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/.exec(
      filename,
    );
  return match?.[1];
};

const findCodexSessionPath = async (
  rootDir: string,
  id: string,
): Promise<string | undefined> => {
  const visit = async (dir: string): Promise<string | undefined> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isFile() && isCodexSessionFilename(entry.name, id)) {
        return child;
      }
      if (entry.isDirectory()) {
        const found = await visit(child);
        if (found) return found;
      }
    }
    return undefined;
  };

  return visit(rootDir);
};

export const codexHostSessionStore = (
  cwd: string,
  sessionsDir?: string,
): LocatableSessionStore => {
  const rootDir =
    sessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
  const locatedPaths = new Map<string, string>();

  const locateSession = async (
    id: string,
  ): Promise<{ path: string; relativePath: string }> => {
    const path = await findCodexSessionPath(rootDir, id);
    if (!path) {
      throw new Error(`session ${id} not found in ${rootDir}`);
    }
    locatedPaths.set(id, path);
    return { path, relativePath: relative(rootDir, path) };
  };

  return {
    cwd,
    locateSession,
    sessionFilePath: (id: string): string | undefined => locatedPaths.get(id),
    exists: async (id: string): Promise<boolean> => {
      return (await findCodexSessionPath(rootDir, id)) !== undefined;
    },
    readSession: async (id: string): Promise<string> => {
      const located = await locateSession(id);
      return readFile(located.path, "utf-8");
    },
    writeSession: async (id: string, content: string): Promise<void> => {
      const existing = await findCodexSessionPath(rootDir, id);
      const target =
        existing ??
        join(rootDir, "unknown-date", `rollout-${Date.now()}-${id}.jsonl`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      locatedPaths.set(id, target);
    },
    writeSessionAt: async (
      relativePath: string,
      content: string,
    ): Promise<void> => {
      const target = join(rootDir, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      const id = codexIdFromFilename(posix.basename(relativePath));
      if (id) locatedPaths.set(id, target);
    },
  };
};

export const codexSandboxSessionStore = (
  cwd: string,
  handle: Pick<BindMountSandboxHandle, "copyFileIn" | "copyFileOut" | "exec">,
  sessionsDir: string = posix.join("/home/agent", ".codex", "sessions"),
): LocatableSessionStore => {
  const locatedPaths = new Map<string, string>();

  const writeSessionAt = async (
    relativePath: string,
    content: string,
  ): Promise<void> => {
    const sandboxPath = posix.join(sessionsDir, relativePath);
    const tmpPath = join(
      tmpdir(),
      `sandcastle-codex-session-${Date.now()}.jsonl`,
    );
    await writeFile(tmpPath, content);
    try {
      await handle.exec(
        `mkdir -p ${JSON.stringify(posix.dirname(sandboxPath))}`,
      );
      await handle.copyFileIn(tmpPath, sandboxPath);
      const id = codexIdFromFilename(posix.basename(relativePath));
      if (id) locatedPaths.set(id, sandboxPath);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  };

  const locateSession = async (
    id: string,
  ): Promise<{ path: string; relativePath: string }> => {
    const result = await handle.exec(
      `find ${JSON.stringify(sessionsDir)} -type f -name ${JSON.stringify(`rollout-*-${id}.jsonl`)} -print -quit`,
    );
    const path = result.stdout.trim().split("\n")[0];
    if (result.exitCode !== 0 || !path) {
      throw new Error(`session ${id} not found in ${sessionsDir}`);
    }
    locatedPaths.set(id, path);
    return { path, relativePath: posix.relative(sessionsDir, path) };
  };

  return {
    cwd,
    locateSession,
    sessionFilePath: (id: string): string | undefined => locatedPaths.get(id),
    exists: async (id: string): Promise<boolean> => {
      const result = await handle.exec(
        `find ${JSON.stringify(sessionsDir)} -type f -name ${JSON.stringify(`rollout-*-${id}.jsonl`)} -print -quit`,
      );
      return result.exitCode === 0 && result.stdout.trim().length > 0;
    },
    readSession: async (id: string): Promise<string> => {
      const located = await locateSession(id);
      const tmpPath = join(
        tmpdir(),
        `sandcastle-codex-session-${id}-${Date.now()}.jsonl`,
      );
      await handle.copyFileOut(located.path, tmpPath);
      try {
        return await readFile(tmpPath, "utf-8");
      } finally {
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    },
    writeSession: async (id: string, content: string): Promise<void> => {
      const existing = await locateSession(id).catch(() => undefined);
      const relativePath =
        existing?.relativePath ??
        posix.join("unknown-date", `rollout-${Date.now()}-${id}.jsonl`);
      await writeSessionAt(relativePath, content);
    },
    writeSessionAt,
  };
};

const rewriteSessionCwd = (content: string, fromCwd: string, toCwd: string) => {
  if (content === "") return "";
  return content
    .split("\n")
    .map((line) => {
      if (line === "") return line;
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (typeof entry.cwd === "string" && entry.cwd === fromCwd) {
        entry.cwd = toCwd;
      }
      if (
        entry.type === "session_meta" &&
        typeof entry.payload === "object" &&
        entry.payload !== null &&
        typeof (entry.payload as { cwd?: unknown }).cwd === "string" &&
        (entry.payload as { cwd: string }).cwd === fromCwd
      ) {
        (entry.payload as { cwd: string }).cwd = toCwd;
      }
      return JSON.stringify(entry);
    })
    .join("\n");
};

export const transferCodexSession = async (
  from: SessionStore,
  to: SessionStore,
  id: string,
): Promise<void> => {
  const locatableFrom = from as LocatableSessionStore;
  const locatableTo = to as LocatableSessionStore;
  const located = await locatableFrom.locateSession(id);
  const content = await from.readSession(id);
  const rewritten = rewriteSessionCwd(content, from.cwd, to.cwd);
  await locatableTo.writeSessionAt(located.relativePath, rewritten);
  await locatableTo.locateSession(id).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// transferSession
// ---------------------------------------------------------------------------

/**
 * Transfer a session from one store to another, rewriting `cwd` fields in
 * the JSONL entries from the source store's cwd to the target store's cwd.
 */
export const transferSession = async (
  from: SessionStore,
  to: SessionStore,
  id: string,
): Promise<void> => {
  const content = await from.readSession(id);

  if (content === "") {
    await to.writeSession(id, "");
    return;
  }

  const rewritten = rewriteSessionCwd(content, from.cwd, to.cwd);

  await to.writeSession(id, rewritten);
};
