export const MIN_API_VERSION_MAJOR = 65;

export function normalizeApiVersion(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^v?(\d{2,3})\.0$/i.exec(trimmed);
  if (!match) {
    return undefined;
  }
  return `v${Number(match[1])}.0`;
}

export function apiVersionMajor(version: string): number {
  const normalized = normalizeApiVersion(version);
  if (!normalized) {
    throw new Error(`Invalid Salesforce API version: ${version}`);
  }
  const major = Number(normalized.slice(1).split(".")[0]);
  return major;
}

export function isSupportedApiVersion(version: string): boolean {
  try {
    return apiVersionMajor(version) >= MIN_API_VERSION_MAJOR;
  } catch {
    return false;
  }
}

/**
 * Choose the highest numeric API version from a /services/data/ response.
 * Duplicate entries (Salesforce does return them) are harmless.
 */
export function selectHighestVersion(versions: readonly string[]): string | undefined {
  let best: { version: string; major: number } | undefined;
  for (const candidate of versions) {
    const normalized = normalizeApiVersion(candidate);
    if (!normalized) {
      continue;
    }
    const major = apiVersionMajor(normalized);
    if (!best || major > best.major) {
      best = { version: normalized, major };
    }
  }
  return best?.version;
}

export function pickUsableVersion(options: {
  configured?: string;
  discovered?: string[];
  orgApiVersion?: string;
}): { version: string; source: "configured" | "discovered" | "org" } {
  if (options.configured && options.configured.trim()) {
    const normalized = normalizeApiVersion(options.configured);
    if (!normalized) {
      throw new Error(
        `Invalid API version setting "${options.configured}". Use a value such as v65.0 or leave it empty for auto-detection.`
      );
    }
    if (!isSupportedApiVersion(normalized)) {
      throw new Error(
        `API version ${normalized} is not supported for credential rotation. Use v${MIN_API_VERSION_MAJOR}.0 or later.`
      );
    }
    return { version: normalized, source: "configured" };
  }

  const highest = selectHighestVersion(options.discovered ?? []);
  if (highest && isSupportedApiVersion(highest)) {
    return { version: highest, source: "discovered" };
  }

  const orgVersion = options.orgApiVersion ? normalizeApiVersion(options.orgApiVersion) : undefined;
  if (orgVersion && isSupportedApiVersion(orgVersion)) {
    return { version: orgVersion, source: "org" };
  }

  throw new Error(
    `The selected org does not advertise an API version of v${MIN_API_VERSION_MAJOR}.0 or later. Credential rotation requires v${MIN_API_VERSION_MAJOR}.0 or later.`
  );
}
