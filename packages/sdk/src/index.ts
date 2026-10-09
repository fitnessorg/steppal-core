import {
  StepPalError,
  type PotDetail,
  type PotSummary,
  type Session,
  type StepDay,
  type StepSource,
  type StepSubmissionResult,
  type User,
} from "./types.js";

export * from "./types.js";

export type TokenPair = { accessToken: string; refreshToken: string };

export type ClientOptions = {
  baseUrl: string;
  /** Returns the stored tokens, or null when signed out. */
  getTokens?: () => TokenPair | null | Promise<TokenPair | null>;
  /** Called whenever the tokens change, including when they are cleared. */
  onTokens?: (tokens: TokenPair | null) => void | Promise<void>;
  fetch?: typeof globalThis.fetch;
};

/**
 * A typed client for the StepPal API.
 *
 * It owns one piece of real behaviour beyond shaping requests: when a call
 * returns 401 it refreshes once, retries, and gives up if that also fails.
 * Access tokens live fifteen minutes and phones sit in pockets for hours, so
 * without this every screen would have to handle "your token expired" itself,
 * and one of them would forget.
 *
 * Refreshes are de-duplicated. Three screens waking at once produce one refresh,
 * not three — and since refresh tokens rotate on use, three would mean two of
 * them racing to revoke each other.
 */
export class StepPalClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly getTokens: () => TokenPair | null | Promise<TokenPair | null>;
  private readonly onTokens: (t: TokenPair | null) => void | Promise<void>;

  private tokens: TokenPair | null = null;
  private refreshing: Promise<TokenPair | null> | null = null;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.getTokens = options.getTokens ?? (() => this.tokens);
    this.onTokens = options.onTokens ?? (() => {});
  }

  // ---- auth ----

  async requestCode(phone: string): Promise<{ ok: true; expiresInSeconds: number }> {
    return this.call("POST", "/v1/auth/request-code", { body: { phone }, auth: false });
  }

  async verifyCode(phone: string, code: string, displayName?: string): Promise<Session> {
    const session = await this.call<Session>("POST", "/v1/auth/verify-code", {
      body: { phone, code, ...(displayName ? { displayName } : {}) },
      auth: false,
    });
    await this.setTokens({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    });
    return session;
  }

  async logout(): Promise<void> {
    const tokens = await this.currentTokens();
    if (tokens) {
      // A failure here is not worth surfacing: the local tokens are dropped
      // either way, and a signed-out user does not care that the server missed
      // the message.
      await this.call("POST", "/v1/auth/logout", {
        body: { refreshToken: tokens.refreshToken },
        auth: false,
      }).catch(() => undefined);
    }
    await this.setTokens(null);
  }

  // ---- me ----

  me(): Promise<User> {
    return this.call("GET", "/v1/me");
  }

  updateMe(patch: { displayName?: string; dailyGoal?: number }): Promise<User> {
    return this.call("PATCH", "/v1/me", { body: patch });
  }

  // ---- pots ----

  listPots(): Promise<PotSummary[]> {
    return this.call("GET", "/v1/pots");
  }

  createPot(input: {
    name: string;
    dailyGoal?: number;
    stakeKobo?: number;
    startsOn?: string;
    days?: number;
  }): Promise<PotSummary> {
    return this.call("POST", "/v1/pots", { body: input });
  }

  potByCode(code: string): Promise<PotSummary> {
    return this.call("GET", `/v1/pots/by-code/${encodeURIComponent(code)}`);
  }

  joinPot(code: string): Promise<PotSummary> {
    return this.call("POST", "/v1/pots/join", { body: { code } });
  }

  getPot(id: string): Promise<PotDetail> {
    return this.call("GET", `/v1/pots/${id}`);
  }

  leavePot(id: string): Promise<{ ok: true }> {
    return this.call("POST", `/v1/pots/${id}/leave`);
  }

  // ---- steps ----

  submitSteps(
    days: { day: string; steps: number; source?: StepSource }[],
  ): Promise<StepSubmissionResult> {
    return this.call("POST", "/v1/steps", { body: { days } });
  }

  async getSteps(range?: { from?: string; to?: string }): Promise<StepDay[]> {
    const query = new URLSearchParams();
    if (range?.from) query.set("from", range.from);
    if (range?.to) query.set("to", range.to);
    const suffix = query.toString() ? `?${query}` : "";
    const res = await this.call<{ days: StepDay[] }>("GET", `/v1/steps${suffix}`);
    return res.days;
  }

  // ---- plumbing ----

  private async currentTokens(): Promise<TokenPair | null> {
    return (await this.getTokens()) ?? null;
  }

  private async setTokens(tokens: TokenPair | null) {
    this.tokens = tokens;
    await this.onTokens(tokens);
  }

  private async call<T>(
    method: string,
    path: string,
    options: { body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const needsAuth = options.auth !== false;
    const first = await this.send(method, path, options.body, needsAuth);

    if (first.status !== 401 || !needsAuth) return this.unwrap<T>(first);

    const refreshed = await this.refreshOnce();
    if (!refreshed) return this.unwrap<T>(first);

    return this.unwrap<T>(await this.send(method, path, options.body, true));
  }

  private async send(method: string, path: string, body: unknown, auth: boolean) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";

    if (auth) {
      const tokens = await this.currentTokens();
      if (tokens) headers["authorization"] = `Bearer ${tokens.accessToken}`;
    }

    return this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async refreshOnce(): Promise<TokenPair | null> {
    this.refreshing ??= this.performRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async performRefresh(): Promise<TokenPair | null> {
    const tokens = await this.currentTokens();
    if (!tokens) return null;

    const res = await this.send(
      "POST",
      "/v1/auth/refresh",
      { refreshToken: tokens.refreshToken },
      false,
    );

    if (!res.ok) {
      // The refresh token is dead. Clearing it is what moves the app to the
      // sign-in screen rather than looping on 401 forever.
      await this.setTokens(null);
      return null;
    }

    const next = (await res.json()) as TokenPair;
    await this.setTokens(next);
    return next;
  }

  private async unwrap<T>(res: Response): Promise<T> {
    if (res.ok) return (await res.json()) as T;

    let code = "request_failed";
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error ?? body.message ?? code;
    } catch {
      // A non-JSON error body (a proxy's HTML 502, say) is still an error.
    }

    throw new StepPalError(res.status, code);
  }
}

export function createClient(options: ClientOptions): StepPalClient {
  return new StepPalClient(options);
}
