import { existsSync, lstatSync, realpathSync, statSync } from 'fs';
import { stat } from 'fs/promises';
import os from 'os';
import path from 'path';

const DEFAULT_ALLOWED_ROOTS = [os.homedir(), process.cwd()];

function configuredAllowedRoots(): string[] {
  const configured = process.env.EVERNOTE_ALLOWED_FILE_ROOTS;
  if (!configured) {
    return DEFAULT_ALLOWED_ROOTS;
  }

  return configured
    .split(path.delimiter)
    .map(root => root.trim())
    .filter(Boolean);
}

function normalizeRoot(root: string): string | null {
  const expanded = root.startsWith('~/')
    ? path.join(os.homedir(), root.slice(2))
    : root;
  const absolute = path.resolve(expanded);

  try {
    return realpathSync.native(absolute);
  } catch {
    return null;
  }
}

function isWithinRoot(realCandidate: string, realRoot: string): boolean {
  const candidate = comparablePath(realCandidate);
  const root = comparablePath(realRoot);
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function comparablePath(filePath: string): string {
  const normalized = path.normalize(filePath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function getAllowedFileRoots(): string[] {
  return configuredAllowedRoots()
    .map(normalizeRoot)
    .filter((root): root is string => !!root);
}

export function validateLocalFilePathSync(filePath: string): string | null {
  const absolute = path.resolve(filePath);
  if (!existsSync(absolute)) {
    return null;
  }

  let realCandidate: string;
  try {
    realCandidate = realpathSync.native(absolute);
    if (!statSync(realCandidate).isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const allowedRoots = getAllowedFileRoots();
  if (allowedRoots.some(root => isWithinRoot(realCandidate, root))) {
    return realCandidate;
  }

  return null;
}

export async function validateLocalFilePath(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  let realCandidate: string;
  try {
    realCandidate = realpathSync.native(absolute);
  } catch {
    throw new Error(`File path rejected: ${absolute} does not exist`);
  }

  const fileStat = await stat(realCandidate);
  if (!fileStat.isFile()) {
    throw new Error(`File path rejected: ${realCandidate} is not a file`);
  }

  const allowedRoots = getAllowedFileRoots();
  if (allowedRoots.some(root => isWithinRoot(realCandidate, root))) {
    return realCandidate;
  }

  throw new Error(
    `File path rejected: ${realCandidate} is outside allowed roots: ${allowedRoots.join(', ')}`,
  );
}

/**
 * Validate a destination path for writing a file. The path may not exist yet.
 * If it exists, it must be a regular file inside an allowed root (overwrite
 * is allowed). If it does not, the parent directory must exist and be inside
 * an allowed root. Symlinks are resolved so a link cannot escape the roots.
 */
export async function validateWritableFilePath(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath);
  const allowedRoots = getAllowedFileRoots();
  if (allowedRoots.length === 0) {
    throw new Error('File path rejected: no allowed roots are configured');
  }

  // Use lstat so a dangling symlink is not treated as "does not exist".
  // existsSync follows links and returns false for dangling ones, which would
  // let writeFile create the external target and escape the allowed roots.
  let lst: ReturnType<typeof lstatSync> | undefined;
  try {
    lst = lstatSync(absolute);
  } catch {
    lst = undefined;
  }

  if (lst) {
    if (lst.isSymbolicLink()) {
      let realCandidate: string;
      try {
        realCandidate = realpathSync.native(absolute);
      } catch {
        throw new Error(
          `File path rejected: ${absolute} is a dangling symlink`,
        );
      }
      const fileStat = await stat(realCandidate);
      if (!fileStat.isFile()) {
        throw new Error(`File path rejected: ${realCandidate} is not a file`);
      }
      if (allowedRoots.some(root => isWithinRoot(realCandidate, root))) {
        return realCandidate;
      }
      throw new Error(
        `File path rejected: ${realCandidate} is outside allowed roots: ${allowedRoots.join(', ')}`,
      );
    }

    if (!lst.isFile()) {
      throw new Error(`File path rejected: ${absolute} is not a file`);
    }

    let realCandidate: string;
    try {
      realCandidate = realpathSync.native(absolute);
    } catch {
      throw new Error(`File path rejected: ${absolute} cannot be resolved`);
    }
    if (allowedRoots.some(root => isWithinRoot(realCandidate, root))) {
      return realCandidate;
    }
    throw new Error(
      `File path rejected: ${realCandidate} is outside allowed roots: ${allowedRoots.join(', ')}`,
    );
  }

  const parent = path.dirname(absolute);
  const base = path.basename(absolute);
  if (!base || base === '.' || base === '..') {
    throw new Error(`File path rejected: ${absolute} has no file name`);
  }

  let realParent: string;
  try {
    realParent = realpathSync.native(parent);
  } catch {
    throw new Error(`File path rejected: parent directory ${parent} does not exist`);
  }

  const parentStat = await stat(realParent);
  if (!parentStat.isDirectory()) {
    throw new Error(`File path rejected: parent ${realParent} is not a directory`);
  }
  if (!allowedRoots.some(root => isWithinRoot(realParent, root))) {
    throw new Error(
      `File path rejected: ${absolute} is outside allowed roots: ${allowedRoots.join(', ')}`,
    );
  }
  return path.join(realParent, base);
}
