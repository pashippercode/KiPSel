import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  MARKER_TYPE,
  backoffDelay,
  harvestResult,
  hasUserAfterMarker,
  makeMarkerData,
  parseRuntimeConfig,
  sleepAbortable,
  toUserContent,
  validateJobPayload,
  type HarvestResult,
  type JobPayload,
  type RuntimeConfig,
} from "./core.ts";

const HEARTBEAT_MS = 10_000;
const DISPATCH_TIMEOUT_MS = 120_000;
const STATUS_KEY = "kipsel";
const MAX_RESULT_CHARS = 100_000;
const MAX_TERMINAL_ATTEMPTS = 5;

class InternalRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`KiPSel internal request failed (${status}/${code})`);
    this.name = "InternalRequestError";
    this.status = status;
    this.code = code;
  }
}

interface ActiveJob {
  job: JobPayload;
  acknowledged: boolean;
  dispatchRequested: boolean;
  injectionObserved: boolean;
  sent: boolean;
  localInterruption: boolean;
  dispatchStartedAt: number | null;
  terminalAttempts: number;
  terminal:
    | { path: "/internal/job/result"; body: { text: string; interrupted: boolean } }
    | { path: "/internal/job/fail"; body: { code: string } }
    | null;
  postingTerminal: boolean;
}

interface PollEnvelope {
  kind?: unknown;
  job?: unknown;
  control?: {
    id?: unknown;
    type?: unknown;
    jobId?: unknown;
    force?: unknown;
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function terminalConflict(error: unknown): boolean {
  return (
    error instanceof InternalRequestError &&
    (error.status === 404 || (error.status === 409 && error.code === "lease-mismatch"))
  );
}

function expectedAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

export default function kipselExtension(pi: ExtensionAPI): void {
  let configuration: RuntimeConfig | null = null;
  let latestContext: ExtensionContext | null = null;
  let lifecycle: AbortController | null = null;
  let active: ActiveJob | null = null;
  let injectingJobId: string | null = null;
  let connected = false;
  let runtimeStarted = false;

  function statusText(): string | undefined {
    if (!configuration) return undefined;
    const state = active ? "busy" : connected ? "ready" : "offline";
    return `KiPSel:${configuration.alias} ${state}`;
  }

  function refreshStatus(): void {
    latestContext?.ui.setStatus(STATUS_KEY, statusText());
  }

  async function postInternal(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (!configuration || !lifecycle) {
      throw new InternalRequestError(503, "runtime-inactive");
    }
    const signal = AbortSignal.any([
      lifecycle.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const response = await fetch(`${configuration.internalUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${configuration.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: configuration.sessionId, ...body }),
      cache: "no-store",
      signal,
    });
    let decoded: Record<string, unknown> = {};
    try {
      decoded = objectValue(await response.json());
    } catch {
      throw new InternalRequestError(response.status, "invalid-response");
    }
    if (!response.ok) {
      throw new InternalRequestError(
        response.status,
        typeof decoded.error === "string" ? decoded.error : "request-failed",
      );
    }
    return decoded;
  }

  function branchEntries(): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
    return latestContext?.sessionManager.getBranch() ?? [];
  }

  function clearActiveJob(jobId: string): void {
    if (active?.job.id !== jobId) return;
    active = null;
    if (injectingJobId === jobId) injectingJobId = null;
    refreshStatus();
  }

  async function postTerminal(job: ActiveJob): Promise<void> {
    if (!job.terminal || job.postingTerminal || active !== job) return;
    job.postingTerminal = true;
    try {
      await postInternal(
        job.terminal.path,
        {
          jobId: job.job.id,
          leaseId: job.job.leaseId,
          ...job.terminal.body,
        },
        15_000,
      );
      clearActiveJob(job.job.id);
    } catch (error) {
      if (terminalConflict(error)) clearActiveJob(job.job.id);
      else if (
        error instanceof InternalRequestError &&
        error.status === 413 &&
        job.terminal.path === "/internal/job/result"
      ) {
        job.terminal = {
          path: "/internal/job/fail",
          body: { code: "result-too-large" },
        };
      } else if (++job.terminalAttempts >= MAX_TERMINAL_ATTEMPTS) {
        // 放弃前尽最大努力让 controller 终态化，避免服务端 job 永久 running。
        try {
          await postInternal(
            "/internal/job/fail",
            {
              jobId: job.job.id,
              leaseId: job.job.leaseId,
              code: "terminal-report-failed",
            },
            5_000,
          );
        } catch {}
        clearActiveJob(job.job.id);
      }
    } finally {
      job.postingTerminal = false;
    }
  }

  async function failActive(job: ActiveJob, code: string): Promise<void> {
    if (active !== job) return;
    job.terminal = {
      path: "/internal/job/fail",
      body: { code: code.slice(0, 64) || "extension-error" },
    };
    await postTerminal(job);
  }

  async function finishActive(job: ActiveJob, result?: HarvestResult): Promise<void> {
    if (active !== job || job.terminal) {
      if (active === job) await postTerminal(job);
      return;
    }
    const harvested = result ?? harvestResult(branchEntries(), job.job.id);
    if (harvested.status === "pending") {
      if (job.localInterruption) {
        job.terminal = {
          path: "/internal/job/result",
          body: { text: "", interrupted: true },
        };
        await postTerminal(job);
      }
      return;
    }
    if (harvested.status === "error") {
      await failActive(job, harvested.errorCode ?? "assistant-error");
      return;
    }
    job.terminal = {
      path: "/internal/job/result",
      body: {
        text: (harvested.text ?? "").slice(0, MAX_RESULT_CHARS),
        interrupted: harvested.interrupted || job.localInterruption,
      },
    };
    await postTerminal(job);
  }

  function dispatchActive(job: ActiveJob): void {
    const context = latestContext;
    if (
      active !== job ||
      job.sent ||
      job.dispatchRequested ||
      !job.acknowledged ||
      !context?.isIdle() ||
      context.hasPendingMessages()
    ) {
      return;
    }
    job.dispatchRequested = true;
    job.dispatchStartedAt = Date.now();
    injectingJobId = job.job.id;
    pi.sendUserMessage(
      toUserContent(job.job) as Parameters<ExtensionAPI["sendUserMessage"]>[0],
    );
  }

  async function inspectActiveWhenIdle(): Promise<void> {
    const context = latestContext;
    const job = active;
    if (!context || !job || !context.isIdle()) return;
    if (job.terminal) {
      await postTerminal(job);
      return;
    }
    if (hasUserAfterMarker(branchEntries(), job.job.id)) {
      job.sent = true;
      const harvested = harvestResult(branchEntries(), job.job.id);
      if (harvested.status === "pending" && job.localInterruption) {
        await finishActive(job, harvested);
      } else if (harvested.status !== "pending") {
        await finishActive(job, harvested);
      } else if (
        !job.dispatchRequested ||
        (job.dispatchStartedAt !== null &&
          Date.now() - job.dispatchStartedAt >= DISPATCH_TIMEOUT_MS)
      ) {
        // resume 重接纳的任务没有 dispatch 状态：此处只在 pi 已空闲时命中，
        // agent 仍在产出时 inspectActiveWhenIdle 开头即返回，不会误报。
        await failActive(job, "missing-assistant-result");
      }
      return;
    }
    if (
      job.dispatchRequested &&
      job.dispatchStartedAt !== null &&
      Date.now() - job.dispatchStartedAt >= DISPATCH_TIMEOUT_MS
    ) {
      await failActive(job, "dispatch-timeout");
      return;
    }
    dispatchActive(job);
  }

  async function acceptJob(rawJob: unknown, resumed: boolean): Promise<void> {
    const validated = validateJobPayload(rawJob);
    if (!validated.ok) return;
    const incoming = validated.value;
    if (active) {
      if (active.job.id === incoming.id) return;
      if (!resumed) {
        try {
          await postInternal(
            "/internal/job/fail",
            {
              jobId: incoming.id,
              leaseId: incoming.leaseId,
              code: "extension-busy",
            },
            5_000,
          );
        } catch {}
      }
      return;
    }

    const alreadySent = hasUserAfterMarker(branchEntries(), incoming.id);
    if (!alreadySent) pi.appendEntry(MARKER_TYPE, makeMarkerData(incoming.id));
    const job: ActiveJob = {
      job: incoming,
      acknowledged: resumed,
      dispatchRequested: false,
      injectionObserved: false,
      sent: alreadySent,
      localInterruption: false,
      dispatchStartedAt: null,
      terminalAttempts: 0,
      terminal: null,
      postingTerminal: false,
    };
    active = job;
    refreshStatus();

    if (!resumed) {
      try {
        await postInternal(
          "/internal/job/ack",
          { jobId: incoming.id, leaseId: incoming.leaseId },
          5_000,
        );
        job.acknowledged = true;
      } catch (error) {
        if (active === job) clearActiveJob(incoming.id);
        throw error;
      }
    }
    await inspectActiveWhenIdle();
  }

  async function acknowledgeControl(controlId: string): Promise<void> {
    try {
      await postInternal(
        "/internal/control/ack",
        { controlId },
        3_000,
      );
    } catch {}
  }

  async function handleControl(control: PollEnvelope["control"]): Promise<void> {
    const context = latestContext;
    const controlId = typeof control?.id === "string" ? control.id : "";
    const type = typeof control?.type === "string" ? control.type : "";
    if (!context || !controlId || !["abort", "shutdown"].includes(type)) return;

    if (type === "abort") {
      const requestedJob = typeof control?.jobId === "string" ? control.jobId : null;
      const job = active;
      if (job && (!requestedJob || requestedJob === job.job.id)) {
        job.localInterruption = true;
        if (!context.isIdle()) context.abort();
        else if (job.sent) {
          const harvested = harvestResult(branchEntries(), job.job.id);
          if (harvested.status === "pending") {
            job.terminal = {
              path: "/internal/job/result",
              body: { text: "", interrupted: true },
            };
          } else {
            await finishActive(job, harvested);
          }
        } else {
          job.terminal = {
            path: "/internal/job/result",
            body: { text: "", interrupted: true },
          };
        }
      } else if (!context.isIdle()) {
        context.abort();
      }
      await acknowledgeControl(controlId);
      if (active?.terminal) await postTerminal(active);
      return;
    }

    if (control?.force === true && !context.isIdle()) context.abort();
    await acknowledgeControl(controlId);
    context.shutdown();
  }

  async function pollLoop(signal: AbortSignal): Promise<void> {
    let failedAttempts = 0;
    while (!signal.aborted) {
      try {
        await inspectActiveWhenIdle();
        const context = latestContext;
        const envelope = (await postInternal(
          "/internal/poll",
          {
            ready: Boolean(
              !active && context?.isIdle() && !context.hasPendingMessages(),
            ),
            currentJobId: active?.job.id ?? null,
          },
          32_000,
        )) as PollEnvelope;
        connected = true;
        failedAttempts = 0;
        refreshStatus();
        if (envelope.kind === "job") await acceptJob(envelope.job, false);
        else if (envelope.kind === "resume") await acceptJob(envelope.job, true);
        else if (envelope.kind === "control") await handleControl(envelope.control);
      } catch (error) {
        if (expectedAbort(error, signal)) break;
        connected = false;
        refreshStatus();
        const waited = await sleepAbortable(backoffDelay(failedAttempts++), signal);
        if (!waited) break;
      }
    }
  }

  async function heartbeatLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await postInternal("/internal/heartbeat", {}, 5_000);
        connected = true;
        refreshStatus();
      } catch (error) {
        if (expectedAbort(error, signal)) break;
        connected = false;
        refreshStatus();
      }
      if (!(await sleepAbortable(HEARTBEAT_MS, signal))) break;
    }
  }

  pi.on("session_start", async (_event, context) => {
    latestContext = context;
    if (runtimeStarted) return;
    runtimeStarted = true;
    const parsed = parseRuntimeConfig(process.env);
    if (!parsed.ok || context.mode !== "tui") {
      context.ui.setStatus(STATUS_KEY, "KiPSel disabled");
      context.ui.notify("KiPSel bridge configuration is invalid", "error");
      return;
    }
    if (context.sessionManager.getSessionId() !== parsed.value.sessionId) {
      context.ui.setStatus(STATUS_KEY, "KiPSel disabled");
      context.ui.notify("KiPSel session ownership check failed", "error");
      return;
    }
    configuration = parsed.value;
    lifecycle = new AbortController();
    refreshStatus();
    void heartbeatLoop(lifecycle.signal);
    void pollLoop(lifecycle.signal);
  });

  pi.on("input", (event, context) => {
    latestContext = context;
    const job = active;
    if (!job) return { action: "continue" as const };
    if (
      event.source === "extension" &&
      injectingJobId === job.job.id &&
      job.dispatchRequested &&
      !job.sent
    ) {
      pi.appendEntry(MARKER_TYPE, makeMarkerData(job.job.id));
      job.injectionObserved = true;
      return { action: "continue" as const };
    }
    if (event.source === "interactive") {
      if (!job.sent) {
        context.ui.notify("KiPSel is handing off a queued job; retry shortly", "warning");
        return { action: "handled" as const };
      }
      job.localInterruption = true;
    }
    return { action: "continue" as const };
  });

  pi.on("message_end", (event, context) => {
    latestContext = context;
    const job = active;
    if (!job || event.message.role !== "user") return;
    if (job.injectionObserved && !job.sent) {
      job.sent = true;
      job.injectionObserved = false;
      if (injectingJobId === job.job.id) injectingJobId = null;
    } else if (job.sent) {
      job.localInterruption = true;
    }
  });

  pi.on("agent_settled", async (_event, context) => {
    latestContext = context;
    const job = active;
    if (!job) return;
    if (!job.sent && hasUserAfterMarker(branchEntries(), job.job.id)) job.sent = true;
    if (job.sent) {
      const result = harvestResult(branchEntries(), job.job.id);
      if (result.status === "pending" && !job.localInterruption) {
        await failActive(job, "missing-assistant-result");
      } else {
        await finishActive(job, result);
      }
    } else if (job.localInterruption) {
      // 任务在派发前被中止：以 interrupted 终态化，而不是重新派发。
      await finishActive(job);
    } else {
      dispatchActive(job);
    }
  });

  pi.on("session_before_switch", (_event, context) => {
    latestContext = context;
    if (!configuration) return;
    context.ui.notify("Managed KiPSel sessions cannot switch session files", "warning");
    return { cancel: true };
  });

  pi.on("session_before_fork", (_event, context) => {
    latestContext = context;
    if (!configuration) return;
    context.ui.notify("Managed KiPSel sessions cannot fork", "warning");
    return { cancel: true };
  });

  pi.on("session_before_tree", (_event, context) => {
    latestContext = context;
    if (!configuration) return;
    context.ui.notify("Managed KiPSel sessions cannot change branches", "warning");
    return { cancel: true };
  });

  pi.on("session_before_compact", (_event, context) => {
    latestContext = context;
    if (!configuration || !active) return;
    context.ui.notify("KiPSel compaction postponed while a job is active", "warning");
    return { cancel: true };
  });

  pi.on("session_shutdown", async (event, context) => {
    latestContext = context;
    if (configuration && event.reason !== "reload") {
      try {
        await postInternal("/internal/end", {}, 1_500);
      } catch {}
    }
    lifecycle?.abort();
    lifecycle = null;
    connected = false;
    context.ui.setStatus(STATUS_KEY, undefined);
  });
}
