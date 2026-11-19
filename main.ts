// github-core-clone: the trial entrypoint.
//
// This module owns the forge's process lifecycle. It builds the HTTP server
// from app.ts, binds a port for it, and — when the trial suite is present —
// tells the suite where to reach it and waits for the suite to finish.
//
// In a trial (MAKEFUN_ENV_URL is set) the steps are:
//   1. bind an ephemeral port on the loopback interface;
//   2. POST {"port": <the bound port>} to $MAKEFUN_ENV_URL/register;
//   3. GET $MAKEFUN_ENV_URL/done over and over until it answers {"done": true};
//   4. shut the server down and leave with exit code 0.
// Without a suite (a local run) the server just keeps serving on PORT, or on
// an ephemeral port when PORT is unset, until the process is stopped.

import { createApp } from "./app.ts";

// The interface the forge always binds to.
const LOOPBACK_HOST = "127.0.0.1";
// The suite's origin, when this process runs inside a trial.
const SUITE_URL = process.env.MAKEFUN_ENV_URL ?? "";
// First gap between done polls, doubling from here up to the cap below.
const FIRST_POLL_WAIT_MS = 250;
// Longest gap between done polls.
const LONGEST_POLL_WAIT_MS = 2_000;
// A single done request is never left open longer than this.
const POLL_REQUEST_LIMIT_MS = 30_000;
// How often the register call is retried while the suite is still coming up.
const REGISTER_TRY_LIMIT = 40;
const REGISTER_TRY_WAIT_MS = 500;
// The code the process leaves with once the suite says the trial is over.
const EXIT_WHEN_DONE = 0;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function wantedPort(): number {
  const raw = process.env.PORT ?? "";
  if (raw.trim() === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return 0;
  return parsed;
}

function boundPortOf(server: ReturnType<typeof createApp>): number {
  const info = server.address();
  if (typeof info === "object" && info !== null) return info.port;
  return wantedPort();
}

async function registerWithSuite(port: number): Promise<void> {
  const target = `${withoutTrailingSlash(SUITE_URL)}/register`;
  let lastProblem: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_TRY_LIMIT; attempt += 1) {
    try {
      const reply = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (reply.status === 200 || reply.status === 409) return;
      lastProblem = new Error(`register answered ${reply.status}`);
    } catch (err) {
      lastProblem = err;
    }
    await pause(REGISTER_TRY_WAIT_MS);
  }
  throw lastProblem instanceof Error ? lastProblem : new Error("register failed");
}

async function waitForSuiteDone(): Promise<void> {
  const target = `${withoutTrailingSlash(SUITE_URL)}/done`;
  let attempt = 0;
  while (true) {
    const waitMs = Math.min(LONGEST_POLL_WAIT_MS, FIRST_POLL_WAIT_MS * 2 ** attempt);
    try {
      const reply = await fetch(target, { signal: AbortSignal.timeout(POLL_REQUEST_LIMIT_MS) });
      const body: unknown = await reply.json();
      if (typeof body === "object" && body !== null && (body as { done?: unknown }).done === true) {
        return;
      }
    } catch (err) {
      console.error(`done poll failed, will try again: ${err instanceof Error ? err.message : String(err)}`);
    }
    attempt += 1;
    await pause(waitMs);
  }
}

async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve) => {
    forge.listen(wantedPort(), LOOPBACK_HOST, () => resolve());
  });
  const port = boundPortOf(forge);
  console.log(`github-core-clone forge listening on ${LOOPBACK_HOST}:${port}`);
  if (SUITE_URL === "") {
    console.log("no MAKEFUN_ENV_URL set; serving until stopped");
    return;
  }
  await registerWithSuite(port);
  console.log(`registered port ${port} with the trial suite`);
  await waitForSuiteDone();
  console.log("trial suite is done; shutting the forge down");
  forge.close();
  process.exit(EXIT_WHEN_DONE);
}

run().catch((err: unknown) => {
  console.error(`forge entrypoint failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
