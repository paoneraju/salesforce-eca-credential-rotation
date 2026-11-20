import type { StagedCredentialSecret } from "../types";

export interface CredentialScope {
  orgId?: string;
  orgUsername: string;
  appIdentifier: string;
  consumerId: string;
}

interface CredentialEntry {
  secret: StagedCredentialSecret;
  scope: CredentialScope;
  expiresAt: number;
}

/**
 * In-memory, time-bounded credential holder. Intentionally has no persistence and a
 * toJSON() that returns null so it cannot be serialized into workspace state by accident.
 */
export class CredentialSession {
  #entry: CredentialEntry | undefined;
  #timer: NodeJS.Timeout | undefined;
  #ttlMs: number;
  #listener: (() => void) | undefined;
  readonly #listeners = new Set<() => void>();

  constructor(options?: { ttlMs?: number; onChange?: () => void }) {
    this.#ttlMs = options?.ttlMs ?? 10 * 60 * 1000;
    this.#listener = options?.onChange;
  }

  addListener(listener: () => void): { dispose: () => void } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      }
    };
  }

  setTtlMs(ttlMs: number): void {
    this.#ttlMs = Math.max(60_000, ttlMs);
    this.#scheduleExpiry();
  }

  set(scope: CredentialScope, secret: StagedCredentialSecret): void {
    this.clearTimer();
    this.#entry = {
      scope: { ...scope },
      secret: { ...secret },
      expiresAt: Date.now() + this.#ttlMs
    };
    this.#scheduleExpiry();
    this.#notify();
  }

  get(scope: CredentialScope): StagedCredentialSecret | undefined {
    if (!this.#entry) {
      return undefined;
    }
    if (!this.#matches(this.#entry.scope, scope)) {
      return undefined;
    }
    if (Date.now() >= this.#entry.expiresAt) {
      this.clear();
      return undefined;
    }
    return this.#entry.secret;
  }

  has(scope?: CredentialScope): boolean {
    if (!this.#entry) {
      return false;
    }
    if (Date.now() >= this.#entry.expiresAt) {
      this.clear();
      return false;
    }
    return scope ? this.#matches(this.#entry.scope, scope) : true;
  }

  get expiresAt(): number | undefined {
    return this.#entry?.expiresAt;
  }

  get scope(): CredentialScope | undefined {
    return this.#entry ? { ...this.#entry.scope } : undefined;
  }

  clear(): void {
    const hadEntry = Boolean(this.#entry);
    this.#entry = undefined;
    this.clearTimer();
    if (hadEntry) {
      this.#notify();
    }
  }

  toJSON(): null {
    return null;
  }

  #matches(left: CredentialScope, right: CredentialScope): boolean {
    const orgMatches = left.orgId && right.orgId
      ? left.orgId === right.orgId
      : left.orgUsername.toLowerCase() === right.orgUsername.toLowerCase();
    return (
      Boolean(orgMatches) &&
      left.appIdentifier === right.appIdentifier &&
      left.consumerId === right.consumerId
    );
  }

  #scheduleExpiry(): void {
    this.clearTimer();
    const expiresAt = this.#entry?.expiresAt;
    if (!expiresAt) {
      return;
    }
    const delay = Math.max(0, expiresAt - Date.now());
    this.#timer = setTimeout(() => {
      this.#entry = undefined;
      this.#timer = undefined;
      this.#notify();
    }, delay);
    this.#timer.unref?.();
  }

  private clearTimer(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #notify(): void {
    this.#listener?.();
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
