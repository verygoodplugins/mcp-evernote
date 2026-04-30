import { existsSync, realpathSync, statSync } from 'fs';
import { realpath, stat } from 'fs/promises';
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
    return realpathSync(absolute);
  } catch {
    return null;
  }
}

function isWithinRoot(realCandidate: string, realRoot: string): boolean {
  const relative = path.relative(realRoot, realCandidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
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

  const realCandidate = realpathSync(absolute);
  if (!statSync(realCandidate).isFile()) {
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
    realCandidate = await realpath(absolute);
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
