import http from "node:http";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import QRCode from "qrcode";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tasks = new Map();
let activeWorkflow = null;
let logoutRecoveryRequired = false;
let logoutRecoveryPromise = null;

const config = {
  port: numberEnv("PORT", 8787),
  host: process.env.HOST || "127.0.0.1",
  napcatApiUrl: trimSlash(process.env.NAPCAT_API_URL || "http://127.0.0.1:3000"),
  napcatToken: process.env.NAPCAT_TOKEN || "",
  napcatWebUiApiUrl: trimSlash(process.env.NAPCAT_WEBUI_API_URL || "http://127.0.0.1:6099/api"),
  napcatWebUiConfig: process.env.NAPCAT_WEBUI_CONFIG || "",
  napcatWebUiToken: process.env.NAPCAT_WEBUI_TOKEN || "",
  napcatWebUiCredential: process.env.NAPCAT_WEBUI_CREDENTIAL || "",
  napcatQrImagePath: process.env.NAPCAT_QR_IMAGE_PATH || "",
  bridgeUrl: trimSlash(process.env.BRIDGE_URL || ""),
  bridgeToken: process.env.BRIDGE_TOKEN || "",
  bridgeMiniStartPath: process.env.BRIDGE_MINIAPP_START_PATH || "/api/miniapp/login/start",
  bridgeMiniStatusPath: process.env.BRIDGE_MINIAPP_STATUS_PATH || "/api/miniapp/login/status",
  bridgeMiniCancelPath: process.env.BRIDGE_MINIAPP_CANCEL_PATH || "/api/miniapp/login/cancel",
  bridgeLogoutPath: process.env.BRIDGE_LOGOUT_PATH || "/api/qq/logout",
  workflowTtlMs: numberEnv("WORKFLOW_TTL_MS", 2 * 60 * 1000),
  taskTtlMs: numberEnv("TASK_TTL_MS", 2 * 60 * 1000),
  // 连续取码 N 次后会卡死（实测 3~4 次），达到阈值就主动做一次轻量重置。
  qrReinitThreshold: numberEnv("QR_REINIT_THRESHOLD", 3),
  // 轻量重置（清任务表/工作流/凭证，不动进程）的最小间隔。
  qrSoftResetCooldownMs: numberEnv("QR_SOFT_RESET_COOLDOWN_MS", 20 * 1000),
  // 硬重启 NapCat 的最小间隔，避免失败时反复重启。
  qrReinitCooldownMs: numberEnv("QR_REINIT_COOLDOWN_MS", 60 * 1000),
  // 重启后等待内核就绪的最长时间。
  qrReinitWaitMs: numberEnv("QR_REINIT_WAIT_MS", 120 * 1000),
  // 重启 NapCat 的命令（可用环境变量换成别的管理器/脚本）。
  qrReinitCommand: process.env.QR_REINIT_COMMAND || "systemctl restart napcat-qq",
  apiSigningSecret: process.env.API_SIGNING_SECRET || process.env.SIGNING_SECRET || "qq-miniapp-auth-default-signing-secret",
  corsOrigin: process.env.CORS_ORIGIN || "same-origin",
  miniappSecrets: parseSecrets(process.env.MINIAPP_SECRETS || "{}")
};

let webUiCredential = config.napcatWebUiCredential;
let loginStartPromise = null;

/**
 * 扫码内核健康状态。
 *
 * 现象：连续添加/扫码 3~4 个账号后，QQ 内核的登录服务就卡在 qrcode_scanned 循环，
 * 之后每次取码都返回 "QRCode Get Error"（要等满 10s），再往后工作流锁也释放不掉（WORKFLOW_BUSY）。
 * 手动 `systemctl restart napcat-qq` 能恢复，说明是内核登录服务自身状态坏了。
 *
 * 这里记录连续取码失败次数，达到阈值就自动重启 NapCat + 清工作流锁，并轮询等内核就绪，
 * 让用户在临界点前后不用自己上服务器操作。
 */
const qrHealth = {
  consecutiveFailures: 0,
  successfulCodes: 0,
  // 距上次重置内核以来又出了多少张码。达到阈值就提前重置，避免踩到「3~4 张就卡死」的临界点。
  codesSinceReinit: 0,
  lastFailureAt: 0,
  lastSuccessAt: 0,
  lastReinitAt: 0,
  reinitInFlight: null,
  lastReinitResult: "",
  stuckWorkflows: 0,
  proactiveReinits: 0,
  softResets: 0,
  proactiveResets: 0,
  resetPending: false,
  lastSoftResetAt: 0,
  resetInFlight: null,
};

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function requiresApiSignature(pathname) {
  return pathname === "/api/qq/login/qrcode" ||
    pathname === "/api/qq/login/status" ||
    pathname === "/api/qq/login/status/" ||
    pathname === "/api/qq/miniapp/code" ||
    pathname === "/api/qq/logout";
}

function verifyApiSignature(request) {
  const received = String(request.headers["x-api-signature"] || "");
  if (!received) return { ok: false, code: "SIGNATURE_REQUIRED", error: "X-API-Signature header is required" };
  if (received !== config.apiSigningSecret) return { ok: false, code: "INVALID_SIGNATURE", error: "Invalid API signature" };
  return { ok: true };
}

function parseSecrets(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function webUiConfigCandidates() {
  const candidates = [];
  const add = (value) => {
    const file = String(value || "").trim();
    if (file && !candidates.includes(file)) candidates.push(file);
  };
  add(config.napcatWebUiConfig);
  add(process.env.NAPCAT_WEBUI_CONFIG);
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  for (const root of [appData, localAppData]) {
    add(root && path.join(root, "NapCat", "config", "webui.json"));
    add(root && path.join(root, "Tencent", "QQ", "NapCat", "config", "webui.json"));
  }
  add(path.join(os.homedir(), ".config", "napcat", "webui.json"));
  add(path.join(__dirname, "config", "webui.json"));
  return candidates;
}

function discoverWebUiToken() {
  if (config.napcatWebUiToken) return config.napcatWebUiToken;
  for (const file of webUiConfigCandidates()) {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
      const token = String(parsed?.token || parsed?.Token || "").trim();
      if (token) return token;
    } catch {
      // The file is optional; continue to the next known NapCat location.
    }
  }
  return "";
}

function qrImageCandidates() {
  const candidates = [];
  const add = (value) => {
    const file = String(value || "").trim();
    if (file && !candidates.includes(file)) candidates.push(file);
  };
  add(config.napcatQrImagePath);
  const workdir = process.env.NAPCAT_WORKDIR;
  add(workdir && path.join(workdir, "cache", "qrcode.png"));
  for (const root of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
    add(root && path.join(root, "NapCat", "cache", "qrcode.png"));
    add(root && path.join(root, "Tencent", "QQ", "NapCat", "cache", "qrcode.png"));
  }
  return candidates;
}

function readNapcatQrImage() {
  for (const file of qrImageCandidates()) {
    try {
      const stat = fsSync.statSync(file);
      if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) continue;
      const image = fsSync.readFileSync(file);
      if (image.length > 0) return `data:image/png;base64,${image.toString("base64")}`;
    } catch {
      // NapCat may not have written a QR yet; try the next configured location.
    }
  }
  return undefined;
}

function hasLoggedInUser(user) {
  const id = user?.user_id ?? user?.uin ?? user?.qq ?? user?.id;
  return id !== undefined && id !== null && String(id).trim() !== "" && String(id) !== "0";
}

function extractUserNickname(user) {
  if (user === undefined || user === null) return undefined;
  const nickname = firstResultField(user, ["nickname", "nick", "nickName"]);
  if (nickname === undefined || nickname === null) return undefined;
  const value = String(nickname).trim();
  return value || undefined;
}

function makeId() {
  return crypto.randomBytes(18).toString("hex");
}

function scheduleTaskExpiry(task) {
  if (task.expirationTimer) clearTimeout(task.expirationTimer);
  const delay = Math.max(1, task.expiresAt - Date.now() + 5);
  task.expirationTimer = setTimeout(() => { void expireTaskIfNeeded(task); }, delay);
  task.expirationTimer.unref?.();
}

function removeTaskFromCache(task) {
  if (!task) return;
  if (task.expirationTimer) clearTimeout(task.expirationTimer);
  task.expirationTimer = undefined;
  if (tasks.get(task.id) === task) tasks.delete(task.id);
}

function removeTaskAndLinks(task) {
  if (!task) return;
  removeTaskFromCache(task);
  if (task.kind === "napcat-login") {
    for (const candidate of tasks.values()) {
      if (candidate.kind === "miniapp-login" && candidate.loginTaskId === task.id) removeTaskFromCache(candidate);
    }
  } else if (task.kind === "miniapp-login" && task.loginTaskId) {
    removeTaskFromCache(tasks.get(task.loginTaskId));
  }
}

function createTask(kind, values = {}, ownerKey) {
  const task = {
    id: makeId(),
    kind,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + config.taskTtlMs,
    ownerKey,
    ...values
  };
  tasks.set(task.id, task);
  scheduleTaskExpiry(task);
  return task;
}

function makeWorkflowBusyError(workflow = activeWorkflow) {
  const error = new Error("当前已有其他用户占用 NapCat，请等待其完成登录和取码后再试");
  error.status = 409;
  error.code = "WORKFLOW_BUSY";
  // 工作流已经过期却 masih 被 workflowHoldsAccount 判为占用时 expiresAt 是过去时间，
  // 直接用 Math.max(0, ...) 会得到 0，前端拿不到有效等待时间。这里保证至少给 10s。
  const rawRetry = workflow?.expiresAt ? Math.max(0, workflow.expiresAt - Date.now()) : 0;
  const retryAfterMs = rawRetry > 0 ? rawRetry : 10_000;
  error.payload = {
    phase: workflow?.phase || "unknown",
    expiresAt: workflow?.expiresAt,
    retryAfterMs
  };
  error.retryAfterMs = retryAfterMs;
  return error;
}

// A workflow only holds the QQ account once a QR has actually been scanned,
// or once a logged-in session still needs to be released. A QR that was shown
// but never scanned must not block later login attempts after its TTL expires.
function workflowHoldsAccount(workflow) {
  if (!workflow) return false;
  const loginTask = workflow.loginTaskId && tasks.get(workflow.loginTaskId);
  const miniTask = workflow.miniappTaskId && tasks.get(workflow.miniappTaskId);
  // Hold the account only while a scan is in progress, while a mini-app code
  // exchange is running, or while a logout is unfinished. A confirmed login
  // that has not started its code exchange must not block a panel retry:
  // loginStart() returns the already logged-in account instead of a new QR.
  if (loginTask && loginTask.status === "scanned") return true;
  if (miniTask && ["pending", "scanned"].includes(miniTask.status)) return true;
  return [loginTask, miniTask].some((task) => task && ["pending", "failed"].includes(task.logoutStatus));
}

function expireWorkflowIfNeeded() {
  if (activeWorkflow && activeWorkflow.expiresAt <= Date.now() && !workflowHoldsAccount(activeWorkflow)) {
    activeWorkflow = null;
  }
  return activeWorkflow;
}

async function acquireWorkflow(ownerKey) {
  let current = expireWorkflowIfNeeded();
  // 卡死的工作流（过期但被判定占用）会把扫码永久堵死：先清掉，让本次请求能继续。
  if (current && workflowStuck(current)) {
    console.log("[qr-health] 检测到卡死的工作流，强制释放", JSON.stringify({
      phase: current.phase,
      expiresAt: current.expiresAt,
      overdueMs: Date.now() - current.expiresAt,
    }));
    qrHealth.stuckWorkflows += 1;
    forceClearStuckWorkflow();
    current = null;
  }
  // Take over an unscanned workflow instead of returning WORKFLOW_BUSY: no
  // account is in use yet, and requesting a new QR invalidates the old one.
  if (current && current.ownerKey !== ownerKey && !workflowHoldsAccount(current)) {
    current = activeWorkflow = null;
  }
  if (current && current.ownerKey !== ownerKey) {
    // 真的还有活跃会话在占用：不是卡死，但连续出现同样要走自动恢复。
    const busy = makeWorkflowBusyError(current);
    const recovery = await handleQrFailure(busy.message);
    busy.retryAfterMs = Math.max(1000, Number(recovery?.retryAfterMs) || busy.retryAfterMs || 10_000);
    busy.payload = { ...(busy.payload || {}), retryAfterMs: busy.retryAfterMs };
    if (recovery?.willReinit)
      busy.reinitAttempted = true;
    throw busy;
  }
  if (!current) {
    activeWorkflow = {
      ownerKey,
      phase: "login",
      acquiredAt: Date.now(),
      expiresAt: Date.now() + config.workflowTtlMs,
      loginTaskId: "",
      miniappTaskId: ""
    };
  }
  return activeWorkflow;
}

function requireWorkflowOwner(ownerKey) {
  const current = expireWorkflowIfNeeded();
  if (!current) {
    const error = new Error("请先创建 QQ 扫码登录任务");
    error.status = 409;
    error.code = "WORKFLOW_REQUIRED";
    throw error;
  }
  if (current.ownerKey !== ownerKey) throw makeWorkflowBusyError(current);
  current.expiresAt = Date.now() + config.workflowTtlMs;
  return current;
}

function releaseWorkflow(ownerKey) {
  if (!activeWorkflow || (ownerKey && activeWorkflow.ownerKey !== ownerKey)) return;
  activeWorkflow = null;
}

/**
 * 判断当前工作流是不是「卡死」状态：过期了却还被判定为占用账号。
 *
 * 观察到的故障现场：连加 3~4 个账号后，旧工作流 expiresAt 已经是过去时间，
 * 但 workflowHoldsAccount 仍返回 true（登录任务停在 scanned / 注销 pending），
 * 于是后续每次取码都返回 WORKFLOW_BUSY，永远不会自愈。
 */
function workflowStuck(workflow = activeWorkflow) {
  if (!workflow) return false;
  if (workflow.expiresAt > Date.now()) return false;
  return workflowHoldsAccount(workflow);
}

/** 强制清掉卡死的工作流与相关任务，让扫码能力重新可用。 */
function forceClearStuckWorkflow() {
  if (!activeWorkflow) return false;
  const stuck = workflowStuck(activeWorkflow);
  const loginTask = activeWorkflow.loginTaskId && tasks.get(activeWorkflow.loginTaskId);
  const miniTask = activeWorkflow.miniappTaskId && tasks.get(activeWorkflow.miniappTaskId);
  for (const task of [loginTask, miniTask]) {
    if (!task) continue;
    if (task.expirationTimer) clearTimeout(task.expirationTimer);
    tasks.delete(task.id);
  }
  activeWorkflow = null;
  logoutRecoveryRequired = false;
  return stuck;
}

function publicTask(task) {
  if (!task) return null;
  const login = task.kind === "napcat-login";
  const status = login ? loginState(task) : task.status;
  return {
    id: task.id,
    type: login ? "qq-login" : "miniapp-code",
    appId: task.appId,
    loginTaskId: task.loginTaskId,
    status,
    qrUrl: task.qrUrl,
    qrImage: task.qrImage,
    code: !login && task.status === "success" && task.logoutStatus === "success" ? task.code : undefined,
    scanned: task.scanned,
    confirmed: task.confirmed,
    cancelled: task.cancelled,
    logoutStatus: task.logoutStatus,
    logoutMethod: task.logoutMethod,
    logoutError: task.logoutError,
    released: task.released === true,
    error: task.error,
    expiresAt: task.expiresAt
  };
}

function loginState(task) {
  if (!task) return "unknown";
  if (task.status === "success") return "confirmed";
  if (task.status === "scanned") return "scanned";
  if (task.status === "cancelled") return "cancelled";
  if (task.status === "expired") return "expired";
  if (task.status === "failed") return "failed";
  return "waiting_scan";
}

function expiredTaskPayload(taskId, type) {
  return {
    id: typeof taskId === "string" && taskId.trim() ? taskId : undefined,
    type,
    status: "expired",
    cancelled: true,
    released: true,
    error: "Task not found or expired",
    expiresAt: Date.now()
  };
}

function taskResponseOk(task) {
  return Boolean(task) && !["expired", "failed", "login_required"].includes(task.status);
}

function normalizeBridgeResult(value) {
  if (!value || typeof value !== "object") return {};
  if (value.data && typeof value.data === "object" && !Array.isArray(value.data)) {
    return { ...value, ...value.data };
  }
  return value;
}

function normalizeWebUiResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = { ...value };
  const merge = (candidate) => {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) Object.assign(result, candidate);
  };
  merge(value.data);
  merge(value.result);
  merge(value.data?.result);
  return result;
}

function resultCandidates(value) {
  if (!value || typeof value !== "object") return [value];
  return [value, value.data, value.result, value.data?.result].filter((candidate) => candidate && typeof candidate === "object");
}

function firstResultField(value, names) {
  for (const candidate of resultCandidates(value)) {
    for (const name of names) if (candidate[name] !== undefined && candidate[name] !== null) return candidate[name];
  }
  return undefined;
}

function joinUrl(base, requestPath) {
  if (/^https?:\/\//i.test(requestPath)) return requestPath;
  return `${base}${requestPath.startsWith("/") ? "" : "/"}${requestPath}`;
}

async function requestJson(url, { method = "GET", body, token, headers: extraHeaders } = {}) {
  const headers = { Accept: "application/json", ...(extraHeaders || {}) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12_000)
  });
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }
  if (!response.ok) {
    const error = new Error(`Upstream returned HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function napcatCall(action, params = {}) {
  const payload = await requestJson(joinUrl(config.napcatApiUrl, `/${action}`), {
    method: "POST",
    body: params,
    token: config.napcatToken
  });
  if (payload && typeof payload === "object" && payload.retcode !== undefined && payload.retcode !== 0) {
    const error = new Error(payload.message || payload.wording || `NapCat retcode ${payload.retcode}`);
    error.status = 502;
    error.payload = payload;
    throw error;
  }
  return payload?.data ?? payload;
}

function isWebUiConfigured() {
  return Boolean(config.napcatWebUiApiUrl && (webUiCredential || discoverWebUiToken()));
}

async function ensureWebUiCredential() {
  if (webUiCredential) return webUiCredential;
  const webUiToken = discoverWebUiToken();
  if (!webUiToken) {
    throw new Error("NapCat WebUI token not found. Set NAPCAT_WEBUI_TOKEN or NAPCAT_WEBUI_CONFIG to config/webui.json");
  }
  const hash = crypto.createHash("sha256").update(`${webUiToken}.napcat`, "utf8").digest("hex");
  const payload = await requestJson(joinUrl(config.napcatWebUiApiUrl, "/auth/login"), {
    method: "POST",
    body: { hash }
  });
  if (payload?.code !== undefined && payload.code !== 0) {
    const error = new Error(payload.message || "NapCat WebUI login failed");
    error.status = 502;
    error.payload = payload;
    throw error;
  }
  webUiCredential = payload?.data?.Credential;
  if (!webUiCredential) {
    const error = new Error("NapCat WebUI did not return a credential (2FA may be enabled)");
    error.status = 502;
    throw error;
  }
  return webUiCredential;
}

async function webUiCall(action, params = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const credential = await ensureWebUiCredential();
      const payload = await requestJson(joinUrl(config.napcatWebUiApiUrl, action), {
        method: "POST",
        body: params,
        token: credential
      });
      if (payload?.code !== undefined && payload.code !== 0) {
        const error = new Error(payload.message || "NapCat WebUI request failed");
        error.status = 502;
        error.payload = payload;
        throw error;
      }
      return normalizeWebUiResult(payload);
    } catch (error) {
      lastError = error;
      const unauthorized = /unauthorized|credential|凭证|认证/i.test(`${error.message} ${error.payload?.message || ""}`);
      if (attempt === 0 && unauthorized && (config.napcatWebUiToken || discoverWebUiToken())) {
        // NapCat invalidates an old credential when WebUI auth is repeated or
        // after a token refresh. Drop the cache and authenticate once again.
        webUiCredential = "";
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("NapCat WebUI request failed");
}

/**
 * 读取 QQ 内核登录状态。coreReady=false 表示内核登录服务还没起来（或已卡死），
 * 这时任何取码都会失败，重启是唯一恢复手段。
 */
async function probeQrCore() {
  try {
    const result = await webUiCall("/QQLogin/CheckLoginStatus");
    return {
      ok: true,
      coreReady: Boolean(result?.coreReady),
      isLogin: Boolean(result?.isLogin),
      loginPhase: String(result?.loginPhase || ""),
      qrLoginAccepted: Boolean(result?.qrLoginAccepted),
    };
  } catch (error) {
    return { ok: false, coreReady: false, isLogin: false, loginPhase: "", error: error?.message || "probe failed" };
  }
}

/** 跑一条 shell 命令（重启 NapCat），不引入额外依赖：优先 systemctl，回退到其它命令。 */
function runReinitCommand(command) {
  return new Promise((resolve) => {
    try {
      const child = exec(command, { timeout: 60_000 }, (error, stdout, stderr) => {
        resolve({ ok: !error, error: error?.message || "", stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() });
      });
      child.on?.("error", (error) => resolve({ ok: false, error: error?.message || "spawn failed" }));
    } catch (error) {
      resolve({ ok: false, error: error?.message || "exec failed" });
    }
  });
}

/**
 * 重新初始化 QQ 扫码内核：
 * 1. 重启 NapCat QQ（内核登录服务随之重建）
 * 2. 清掉内存里的工作流锁和任务表（旧任务对应的内核状态已经不存在）
 * 3. 轮询等 coreReady，超时也返回，由调用方按失败处理
 *
 * 整个过程串行：并发请求共用同一个 Promise，不会重复重启。
 */
function reinitQrCore(reason) {
  if (qrHealth.reinitInFlight) return qrHealth.reinitInFlight;
  const startedAt = Date.now();
  qrHealth.lastReinitAt = startedAt;
  console.log(`[qr-health] 重新初始化扫码内核（${reason}），此前连续失败 ${qrHealth.consecutiveFailures} 次`);
  qrHealth.reinitInFlight = (async () => {
    const command = await runReinitCommand(config.qrReinitCommand);
    // 内核已经换了进程，旧的二维码/任务/工作流全部作废。
    tasks.clear();
    activeWorkflow = null;
    logoutRecoveryRequired = false;
    webUiCredential = "";
    // 新内核从零开始计数，重新核算临界点。
    qrHealth.codesSinceReinit = 0;

    const deadline = Date.now() + config.qrReinitWaitMs;
    let probe = { ok: false, coreReady: false, isLogin: false, loginPhase: "" };
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      probe = await probeQrCore();
      if (probe.coreReady) break;
    }

    qrHealth.consecutiveFailures = 0;
    // 本次重启就是为临界点做的：标记已完成，避免又触发一轮。
    qrHealth.resetPending = false;
    qrHealth.lastReinitResult = probe.coreReady
      ? `ok coreReady=true login=${probe.isLogin}`
      : `timeout phase=${probe.loginPhase || "unknown"}`;
    console.log(`[qr-health] 重初始化结束 ${qrHealth.lastReinitResult} （耗时 ${Math.round((Date.now() - startedAt) / 1000)}s，重启命令 ${command.ok ? "成功" : `失败:${command.error}`}）`);
    return { ...probe, restarted: command.ok, commandError: command.error, elapsedMs: Date.now() - startedAt };
  })();
  qrHealth.reinitInFlight.finally(() => {
    qrHealth.reinitInFlight = null;
  });
  return qrHealth.reinitInFlight;
}

/**
 * 轻量重置：只清 miniapp-auth 自己的扫码状态，不碰 NapCat 进程。
 *
 * 实测表明「扫 3~4 次就卡」多数时候是这两处状态脏了：
 *  1. activeWorkflow 卡在旧 ownerKey 上（releaseWorkflow 没跑到），后面全变 WORKFLOW_BUSY；
 *  2. WebUI 的 Credential 被内核换掉，但这里还缓存着旧的，取码一路报 QRCode Get Error。
 * 清掉过期任务 + 工作流 + 凭证再刷一次码，多数情况立刻恢复，而且不会踢掉正在跑的其它账号。
 *
 * 注意：如果当前有真的在用（未过期且已扫码）的会话，直接跳过，绝不打断用户正在进行的扫码。
 */
async function softResetQrState(reason, options = {}) {
  // force=true 供用户手动点「初始化扫码」时使用：用户就是因为扫不动才点，
  // 此时不能因为「工作流还挂着」就跳过，否则按钮永远是「什么也没发生」。
  if (!options.force && activeWorkflow && activeWorkflow.expiresAt > Date.now() && workflowHoldsAccount(activeWorkflow)) {
    return { ok: false, skipped: "workflow-active" };
  }
  console.log(`[qr-health] 轻量重置扫码状态（${reason}）`);
  // 只保留已经扫码确认中的任务（可能正在换 Code），其余孤儿任务全部清掉。
  // 之前无条件 tasks.clear() 会把用户刚拿到、还没扫的二维码一起删掉，前端一查状态就是 WORKFLOW_REQUIRED。
  for (const [id, task] of tasks) {
    if (task.status === "scanned") continue;
    if (task.expirationTimer) clearTimeout(task.expirationTimer);
    tasks.delete(id);
  }
  activeWorkflow = null;
  logoutRecoveryRequired = false;
  webUiCredential = "";
  qrHealth.softResets += 1;
  qrHealth.lastSoftResetAt = Date.now();
  qrHealth.codesSinceReinit = 0;
  try {
    await webUiCall("/QQLogin/RefreshQRcode");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || "refresh failed" };
  }
}

/**
 * 初始化扫码（手动触发，由面板按钮调用）。
 *
 * 分两步，尽量不打断其它在线账号：
 *  1. 轻量重置：清孤儿任务 + 工作流 + WebUI 凭证，再让内核刷一张新码；
 *  2. 内核确实坏了（coreReady=false，或连刷新二维码都不响应）才重启 NapCat。
 *
 * 之前把第 2 步做成自动触发是错的：WORKFLOW_BUSY 只是「上一张码还没处理完」，
 * 自动重启会在 6 分钟里连重启三次、每次空等 120s 超时，还把内核推进 offline。
 * 现在只在用户明确点「初始化扫码」时执行。
 */
async function initializeQrLogin(reason = "手动初始化") {
  const startedAt = Date.now();
  // 手动初始化必须无视「有人在扫」的保护：用户点这个按钮就是因为扫不动了。
  const soft = await softResetQrState(reason, { force: true });
  const softProbe = await probeQrCore();
  if (softProbe.ok) {
    // WebUI 能响应就不算内核坏了。coreReady=false 只表示宿主 QQ 掉登录（waiting_qrcode），
    // 这时要做的是把宿主登录二维码给用户扫，重启 NapCat 完全没用：
    // 重启只会让面板干等 120s，期间一直显示「正在重启」。
    const elapsedMs = Date.now() - startedAt;
    console.log(`[qr-health] 手动初始化完成（轻量，${Math.round(elapsedMs / 1000)}s）coreReady=${Boolean(softProbe.coreReady)} phase=${softProbe.loginPhase || "unknown"}`);
    return {
      mode: "soft",
      ok: true,
      coreReady: Boolean(softProbe.coreReady),
      isLogin: Boolean(softProbe.isLogin),
      loginPhase: softProbe.loginPhase,
      needsHostLogin: !softProbe.coreReady && !softProbe.isLogin,
      elapsedMs,
      softReset: soft.ok,
    };
  }
  // WebUI 自己都不响应了：这才是内核真坏了，重启 NapCat。
  console.log(`[qr-health] 手动初始化：WebUI 无响应（${softProbe.error || "unknown"}），重启 NapCat`);
  // 重启 + 等内核就绪最长要 120s，不能挂在这个 HTTP 请求上（面板/反代会先超时）。
  // reinitQrCore 自带串行锁，重复点击只会复用同一个 Promise，不会重复重启。
  const already = Boolean(qrHealth.reinitInFlight);
  void reinitQrCore(reason).catch(() => null);
  return {
    mode: "hard",
    ok: false,
    coreReady: false,
    restarting: true,
    alreadyRunning: already,
    loginPhase: softProbe.loginPhase,
    retryAfterMs: 20_000,
    message: "QQ 内核无响应，正在重启 NapCat，请约 20 秒后重试取码",
    elapsedMs: Date.now() - startedAt,
    softReset: soft.ok,
  };
}

/**
 * 取码失败时调用：只做轻量重置，**绝不自动重启 NapCat**。
 *
 * 自动重启代价太大且实测会坏事：重启 NapCat 会掐断所有在线账号的 OneBot 连接，
 * 重启期间要等 60~120s 对着一个不可用的内核轮询，多数情况还等不到 coreReady（phase=offline）。
 * 内核真的卡死时由用户在扫码界面点「初始化扫码」手动处理。
 */
async function handleQrFailure(message) {
  qrHealth.consecutiveFailures += 1;
  qrHealth.lastFailureAt = Date.now();
  const text = String(message || "");
  const coreBroken = /qrcode (get|refresh) error/i.test(text);
  const workflowBusy = /已有其他用户占用|WORKFLOW_BUSY/i.test(text);
  const overThreshold = qrHealth.consecutiveFailures >= config.qrReinitThreshold;
  if (!(coreBroken || workflowBusy || overThreshold))
    return { willReinit: false, retryAfterMs: 10_000 };

  // 轻量重置：清孤儿任务 + 工作流 + WebUI 凭证，再让内核刷一张新码，不动进程。
  const sinceSoft = qrHealth.lastSoftResetAt ? Date.now() - qrHealth.lastSoftResetAt : Infinity;
  if (sinceSoft >= config.qrSoftResetCooldownMs) {
    const soft = await softResetQrState(coreBroken ? "取码报错" : workflowBusy ? "工作流占用" : `连续失败 ${qrHealth.consecutiveFailures} 次`);
    if (soft.ok) {
      // 状态已刷新，允许 1.5s 后立刻重试（给内核一点时间把二维码生成出来）。
      return { willReinit: false, softReset: true, recovered: true, retryAfterMs: 1_500 };
    }
    if (soft.skipped)
      return { willReinit: false, retryAfterMs: 10_000, skipped: soft.skipped };
  }

  // 轻量重置也救不回来：明确告诉前端「需要手动初始化」，不再偷偷重启。
  return {
    willReinit: false,
    needsManualInit: true,
    retryAfterMs: 10_000,
    message: "QQ 扫码内核可能已卡死，请点击「初始化扫码」重建",
  };
}

async function bridgeCall(requestPath, options = {}) {
  if (!config.bridgeUrl) throw new Error("BRIDGE_URL is not configured");
  return normalizeBridgeResult(await requestJson(joinUrl(config.bridgeUrl, requestPath), {
    ...options,
    token: config.bridgeToken
  }));
}

function pickQrValue(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return undefined;
  return result.qrcode || result.qrCode || result.qrUrl || result.qr_url ||
    result.image || result.imageUrl || result.image_url || result.base64;
}

async function makeQrImage(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const qr = value.trim();
  if (/^data:image\//i.test(qr)) return qr;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(qr) && qr.length > 128) return `data:image/png;base64,${qr}`;
  return QRCode.toDataURL(qr, { margin: 1, width: 280 });
}

// The panel requires a non-empty qrImage even when the account is already
// logged in and no QR is needed, so supply a 1x1 transparent PNG.
const PLACEHOLDER_QR_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function createLoginTask(ownerKey, values = {}) {
  const filled = values.status === "success" && !values.qrImage
    ? { ...values, qrImage: PLACEHOLDER_QR_IMAGE }
    : values;
  const task = createTask("napcat-login", filled, ownerKey);
  if (activeWorkflow && activeWorkflow.ownerKey === ownerKey) {
    activeWorkflow.loginTaskId = task.id;
    activeWorkflow.phase = task.status === "success" ? "awaiting_code" : "login";
    activeWorkflow.expiresAt = Math.max(activeWorkflow.expiresAt, task.expiresAt);
  }
  return task;
}

async function loginStart() {
  const ownerKey = makeId();
  // 内核正在重启：直接回 NAPCAT_REINIT，不让本次请求再去撞一个已知不可用的内核。
  // 否则每次点击都会叠加一次失败，软重置冷却把用户挡在门外，看起来像「越点越坏」。
  if (qrHealth.reinitInFlight) {
    const restarting = new Error("QQ 扫码内核正在重启，请稍候");
    restarting.status = 503;
    restarting.code = "NAPCAT_REINIT";
    restarting.retryAfterMs = 8_000;
    restarting.payload = { retryAfterMs: 8_000, phase: "reinitializing" };
    throw restarting;
  }
  await ensureLogoutRecovery();
  // acquireWorkflow() owns the busy check: it keeps genuinely active
  // sessions locked but lets a new request replace an unscanned QR.
  if (loginStartPromise) {
    // 上一次取码还卡着：把它当作「扫码能力不可用」处理，走自动恢复而不是直接报忙。
    const busy = makeWorkflowBusyError(activeWorkflow);
    const recovery = await handleQrFailure(busy.message);
    busy.retryAfterMs = Math.max(1000, Number(recovery?.retryAfterMs) || 10_000);
    busy.payload = { ...(busy.payload || {}), retryAfterMs: busy.retryAfterMs };
    if (recovery?.willReinit)
      busy.reinitAttempted = true;
    throw busy;
  }
  await acquireWorkflow(ownerKey);
  const operation = loginStartInternal(ownerKey);
  loginStartPromise = operation;
  try {
    return await operation;
  } catch (error) {
    releaseWorkflow(ownerKey);
    throw error;
  } finally {
    if (loginStartPromise === operation) {
      loginStartPromise = null;
    }
  }
}

function noteQrIssued(ownerKey) {
  qrHealth.consecutiveFailures = 0;
  qrHealth.successfulCodes += 1;
  qrHealth.codesSinceReinit += 1;
  qrHealth.lastSuccessAt = Date.now();
  // 只记计数，供面板展示「本次启动已出码 N 张」。到阈值不再自动重置：
  // 自动重启内核会把在线账号的 OneBot 连接一起掐掉，改由用户点「初始化扫码」。
}

async function loginStartInternal(ownerKey) {
  if (!isWebUiConfigured()) {
    const qrImage = readNapcatQrImage();
    if (qrImage) {
      const task = createLoginTask(ownerKey, { mode: "napcat-file", qrImage });
      try {
        const user = await napcatCall("get_login_info");
        if (hasLoggedInUser(user)) {
          task.status = "success";
          task.user = user;
        }
      } catch {
        // NapCat is expected to reject get_login_info while waiting for a scan.
      }
      return task;
    }
    try {
      const user = await napcatCall("get_login_info");
      if (hasLoggedInUser(user)) return createLoginTask(ownerKey, { mode: "onebot", status: "success", user });
    } catch {
      // Fall through to the actionable configuration error below.
    }
    throw new Error("NapCat QR login is not configured. Set NAPCAT_WEBUI_TOKEN/NAPCAT_WEBUI_CONFIG or NAPCAT_QR_IMAGE_PATH, then retry.");
  }
  try {
    try {
      await webUiCall("/QQLogin/RefreshQRcode");
    } catch {
      // Older NapCat versions may create a fresh QR directly from the getter.
    }
    const result = await webUiCall("/QQLogin/GetQQLoginQrcode");
    const qrValue = pickQrValue(result);
    const qrImage = await makeQrImage(qrValue);
    if (!qrImage) throw new Error("NapCat WebUI did not return a usable QR code");
    noteQrIssued(ownerKey);
    return createLoginTask(ownerKey, {
      mode: "webui-api",
      qrUrl: /^https?:\/\//i.test(String(qrValue || "")) ? qrValue : undefined,
      qrImage
    });
  } catch (error) {
    // 已经登录时 GetQQLoginQrcode 会返回错误，继续读取当前账号。
    try {
      const user = await webUiCall("/QQLogin/GetQQLoginInfo");
      if (hasLoggedInUser(user)) return createLoginTask(ownerKey, { mode: "webui-api", status: "success", user });
      throw error;
    } catch {
      // 内核取码失败：交给自动重初始化判断要不要重启 NapCat。
      const recovery = await handleQrFailure(error?.message || String(error));
      if (recovery?.willReinit && recovery.alreadyLoggedIn) {
        // 重启后 QQ 走快速登录直接进来了：不用二维码，直接返回已登录任务。
        try {
          const user = await webUiCall("/QQLogin/GetQQLoginInfo");
          if (hasLoggedInUser(user)) return createLoginTask(ownerKey, { mode: "webui-api", status: "success", user });
        } catch { /* 继续走下面的重试取码 */ }
      }
      if (recovery?.recovered) {
        // 轻量重置成功或内核重启后已就绪：立刻再取一次码，用户端表现为「等一下自动出码」。
        try {
          const retryResult = await webUiCall("/QQLogin/GetQQLoginQrcode");
          const retryQr = pickQrValue(retryResult);
          const retryImage = await makeQrImage(retryQr);
          if (retryImage) {
            noteQrIssued(ownerKey);
            return createLoginTask(ownerKey, {
              mode: "webui-api",
              qrUrl: /^https?:\/\//i.test(String(retryQr || "")) ? retryQr : undefined,
              qrImage: retryImage
            });
          }
        } catch { /* 仍然失败就走下面的错误分支 */ }
      }
      const wrapped = new Error(error?.message || "QRCode Get Error");
      wrapped.code = recovery?.willReinit ? "NAPCAT_REINIT" : recovery?.softReset ? "NAPCAT_SOFT_RESET" : "QRCODE_FAILED";
      wrapped.retryAfterMs = Math.max(1000, Number(recovery?.retryAfterMs) || 10_000);
      wrapped.reinitAttempted = Boolean(recovery?.willReinit);
      throw wrapped;
    }
  }
}

function mapStatus(result) {
  const status = String(firstResultField(result, ["status", "state", "loginStatus", "login_state"]) || "pending").trim().toLowerCase();
  if (["ok", "success", "succeeded", "logged_in", "connected"].includes(status)) return "success";
  if (["login_required", "not_logged_in", "unauthenticated"].includes(status)) return "login_required";
  if (["failed", "error", "rejected"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["expired", "timeout"].includes(status)) return "expired";
  return "pending";
}

function truthyField(value, names) {
  for (const name of names) {
    const field = firstResultField(value, [name]);
    if (field === true || field === 1 || String(field || "").trim().toLowerCase() === "true") return true;
  }
  return false;
}

function booleanField(value, names) {
  const field = firstResultField(value, names);
  if (field === true || field === 1) return true;
  if (field === false || field === 0) return false;
  const text = String(field || "").trim().toLowerCase();
  if (["true", "yes", "on", "logged_in", "success"].includes(text)) return true;
  if (["false", "no", "off", "not_logged_in", "pending"].includes(text)) return false;
  return undefined;
}

function applyLoginStatus(task, result) {
  const state = String(firstResultField(result, ["status", "state", "loginStatus", "login_state", "qrcodeStatus", "scanStatus"]) || "").trim().toLowerCase();
  const message = String(firstResultField(result, ["loginError", "error", "message", "msg", "wording"]) || "").trim().toLowerCase();
  const isLogin = booleanField(result, ["isLogin", "is_login", "loggedIn", "logged_in"]);
  const expired = ["expired", "timeout"].includes(state) || /expired|timeout|二维码.*过期|已过期|失效/.test(`${state} ${message}`);
  const cancelled = truthyField(result, ["cancelled", "canceled", "isCancelled", "isCanceled", "userCancelled", "userCanceled"]) ||
    /cancel|取消|拒绝|rejected/.test(`${state} ${message}`);
  const waitingScan = /waiting[_\s-]?scan|wait[_\s-]?for[_\s-]?scan|等待扫码|待扫码|未扫码/.test(`${state} ${message}`);
  const explicitScanned = truthyField(result, ["scanned", "isScanned", "isScan", "scan", "hasScan", "hasScanned", "qrcodeScanned", "qrScanned", "scanSuccess", "isScanSuccess"]) ||
    /scanned|scanning|qrcode[_\s-]?scanned|scan[_\s-]?(success|complete|completed)|已扫码|扫码成功/.test(`${state} ${message}`);
  const scanned = explicitScanned ||
    (!waitingScan && /scanned|scanning|qrcode[_\s-]?scanned|scan[_\s-]?(success|complete|completed)|(?:^|[_\s-])scan(?:$|[_\s-])|已扫码|扫码成功|待确认|等待确认|confirm/.test(`${state} ${message}`));
  const confirmed = truthyField(result, ["confirmed", "isConfirmed", "isConfirm", "confirm", "hasConfirm", "authorized", "isAuthorized"]) ||
    ["confirmed", "success", "succeeded", "logged_in", "connected"].includes(state) || isLogin === true;
  task.scanned = task.scanned || scanned || confirmed;
  task.confirmed = task.confirmed || confirmed;
  task.cancelled = task.cancelled || cancelled;
  task.error = firstResultField(result, ["loginError", "error", "message", "msg", "wording"]) || task.error;
  if (expired) task.status = "expired";
  else if (cancelled) task.status = "cancelled";
  else if (task.confirmed || isLogin === true) task.status = "success";
  else if (scanned || confirmed || task.scanned) task.status = "scanned";
  else task.status = "pending";
  return task;
}

async function loginStatus(task) {
  await expireTaskIfNeeded(task);
  if (["pending", "scanned"].includes(task.status)) {
    try {
      if (task.mode === "webui-api") {
        const result = await webUiCall("/QQLogin/CheckLoginStatus");
        applyLoginStatus(task, result);
        if (task.status === "success" || booleanField(result, ["isLogin", "is_login", "loggedIn", "logged_in"]) === true) {
          task.user = await webUiCall("/QQLogin/GetQQLoginInfo");
        }
        const nextQrValue = firstResultField(result, ["qrcodeurl", "qrcode", "qrUrl", "qr_url", "qrCode", "qr_code"]) || task.qrUrl;
        if (nextQrValue && nextQrValue !== task.qrUrl) {
          task.qrUrl = /^https?:\/\//i.test(String(nextQrValue)) ? nextQrValue : task.qrUrl;
          try { task.qrImage = await makeQrImage(nextQrValue); } catch { /* ignore */ }
        }
        task.error = firstResultField(result, ["loginError", "error", "message", "msg", "wording"]) || task.error;
      } else if (task.mode === "napcat-file") {
        task.qrImage = readNapcatQrImage() || task.qrImage;
        const user = await napcatCall("get_login_info");
        if (hasLoggedInUser(user)) {
          task.user = user;
          task.scanned = true;
          task.confirmed = true;
          task.status = "success";
        }
      } else {
        task.user = await napcatCall("get_login_info");
        if (hasLoggedInUser(task.user)) {
          task.scanned = true;
          task.confirmed = true;
          task.status = "success";
        }
      }
    } catch {
      // In WebUI mode an unavailable or not-yet-logged-in NapCat stays pending.
    }
  }
  if (task.status === "expired") {
    await cancelTask(task, task.error || "二维码已过期，请刷新", { expired: true });
  } else if (task.status === "cancelled") {
    await cancelTask(task, task.error || "登录任务已取消");
  }
  if (task.id === activeWorkflow?.loginTaskId) {
    if (["cancelled", "expired", "failed"].includes(task.status) && !["pending", "failed"].includes(task.logoutStatus)) {
      if (task.status === "cancelled") {
        task.cancelled = true;
        task.released = true;
        task.logoutStatus = task.logoutStatus || "not_required";
      }
      releaseWorkflow(task.ownerKey);
    }
    else if (task.status === "success") {
      activeWorkflow.phase = "awaiting_code";
      activeWorkflow.expiresAt = Date.now() + config.workflowTtlMs;
    }
  }
  return task;
}

async function refreshLogin(task) {
  if (!task || task.kind !== "napcat-login") {
    const error = new Error("Login task not found");
    error.status = 404;
    throw error;
  }
  const workflow = await acquireWorkflow(task.ownerKey);
  workflow.loginTaskId = task.id;
  workflow.miniappTaskId = "";
  workflow.phase = "login";
  workflow.expiresAt = Date.now() + config.workflowTtlMs;
  if (task.mode === "napcat-file") {
    task.qrImage = readNapcatQrImage() || task.qrImage;
    task.status = "pending";
    task.error = undefined;
    task.expiresAt = Date.now() + config.taskTtlMs;
    scheduleTaskExpiry(task);
    return task;
  }
  if (task.mode !== "webui-api") {
    const error = new Error("This login mode does not expose QR refresh");
    error.status = 400;
    throw error;
  }
  await webUiCall("/QQLogin/RefreshQRcode");
  const result = await webUiCall("/QQLogin/GetQQLoginQrcode");
  const qrValue = pickQrValue(result);
  const qrImage = await makeQrImage(qrValue);
  if (!qrImage) throw new Error("NapCat WebUI did not return a usable QR code");
  task.qrUrl = /^https?:\/\//i.test(String(qrValue || "")) ? qrValue : undefined;
  task.qrImage = qrImage;
  task.status = "pending";
  task.error = undefined;
  task.expiresAt = Date.now() + config.taskTtlMs;
  scheduleTaskExpiry(task);
  task.scanned = false;
  task.confirmed = false;
  task.cancelled = false;
  if (activeWorkflow?.ownerKey === task.ownerKey) {
    activeWorkflow.phase = "login";
    activeWorkflow.expiresAt = Date.now() + config.workflowTtlMs;
  }
  return task;
}

function validAppId(appId) {
  return typeof appId === "string" && /^[A-Za-z0-9_-]{3,128}$/.test(appId);
}

async function miniappStart(appId, loginTaskId) {
  if (!validAppId(appId)) {
    const error = new Error("appId must be 3-128 ASCII letters, numbers, '_' or '-'");
    error.status = 400;
    throw error;
  }
  const loginTask = tasks.get(loginTaskId);
  if (!loginTaskId) {
    const error = new Error("请提供二维码登录任务 taskId");
    error.status = 409;
    error.code = "WORKFLOW_REQUIRED";
    error.task = expiredTaskPayload(loginTaskId, "qq-login");
    throw error;
  }
  if (!loginTask || loginTask.kind !== "napcat-login") {
    const error = new Error("请先创建 QQ 扫码登录任务");
    error.status = 409;
    error.code = "TASK_EXPIRED";
    error.task = expiredTaskPayload(loginTaskId, "qq-login");
    throw error;
  }
  if (loginTask.status === "expired") {
    const error = new Error("Login task expired");
    error.status = 409;
    error.code = "TASK_EXPIRED";
    error.task = publicTask(loginTask);
    throw error;
  }
  const workflow = requireWorkflowOwner(loginTask.ownerKey);
  await loginStatus(loginTask);
  if (loginTask.status !== "success") {
    const error = new Error("请先完成 QQ 扫码登录，再获取小程序 code");
    error.status = 409;
    error.code = "LOGIN_REQUIRED";
    error.task = publicTask(loginTask);
    throw error;
  }
  if (workflow.miniappTaskId) {
    const existing = tasks.get(workflow.miniappTaskId);
    if (existing && existing.appId === appId && ["pending", "success", "login_required", "failed"].includes(existing.status)) {
      return existing;
    }
  }
  if (workflow.miniappStartPromise) return workflow.miniappStartPromise;
  const operation = startMiniappThroughBridge(appId, loginTask.ownerKey, workflow);
  workflow.miniappStartPromise = operation;
  try {
    return await operation;
  } finally {
    if (workflow.miniappStartPromise === operation) workflow.miniappStartPromise = null;
  }
}

async function startMiniappThroughBridge(appId, ownerKey, workflow) {
  workflow.phase = "miniapp";
  workflow.expiresAt = Date.now() + config.workflowTtlMs;
  if (config.bridgeUrl) {
    const result = await bridgeCall(config.bridgeMiniStartPath, {
      method: "POST",
      body: { appId, source: "qq-miniapp-auth" }
    });
    const loginTask = workflow.loginTaskId ? tasks.get(workflow.loginTaskId) : undefined;
    const task = createTask("miniapp-login", {
      mode: "bridge",
      appId,
      loginTaskId: workflow.loginTaskId,
      upstreamTaskId: result.taskId || result.task_id || result.id,
      status: result.code ? "success" : mapStatus(result),
      code: result.code,
      qrUrl: result.qrUrl || result.qr_url || result.url,
      qrImage: result.qrImage || result.qr_image,
      user: result.user,
      nickname: extractUserNickname(result.nickname !== undefined ? result.nickname : result.user) || extractUserNickname(loginTask?.user),
      error: result.error || result.message
    }, ownerKey);
    workflow.miniappTaskId = task.id;
    workflow.expiresAt = Math.max(workflow.expiresAt, task.expiresAt);
    if (task.status === "success" && !task.code) {
      task.status = "failed";
      task.error = "Bridge reported success without an authorization code";
    }
    if (task.status === "success") await finalizeMiniappTask(task);
    else if (["failed", "expired", "login_required"].includes(task.status)) releaseWorkflow(ownerKey);
    return task;
  }
  const error = new Error("No mini-app bridge configured. Start bridge.js or set BRIDGE_URL.");
  error.status = 503;
  throw error;
}

// NapCat 可能已经处于未登录状态（OneBot context unavailable）。
// 此时没有“上一位 QQ”可注销，直接视为注销完成，避免卡死后续扫码。
async function napCatLoginState() {
  if (!isWebUiConfigured()) return null;
  try {
    return await webUiCall("/QQLogin/CheckLoginStatus");
  } catch {
    return null;
  }
}

async function requestNapcatLogout(taskId) {
  const loginState = await napCatLoginState();
  if (loginState && loginState.isLogin === false) {
    return { loggedOut: true, skipped: "not_logged_in", taskId };
  }
  const result = await bridgeCall(config.bridgeLogoutPath, {
    method: "POST",
    body: { source: "qq-miniapp-auth", taskId }
  });
  if (result?.loggedOut !== true) {
    const error = new Error(result?.error || "NapCat logout did not complete");
    error.payload = result;
    throw error;
  }
  // NapCat 4.18.x can tear down the native wrapper session while leaving its
  // WebUI QQLoginStatus flag set in memory. Ask NapCat to restart its worker
  // so the next QR request is accepted as a fresh login.
  if (isWebUiConfigured()) {
    try {
      await webUiCall("/QQLogin/RestartNapCat");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      let lastStatus;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        try {
          lastStatus = await webUiCall("/QQLogin/CheckLoginStatus");
          if (lastStatus?.isLogin !== true) break;
        } catch {
          // The worker can be briefly unavailable while it is restarting.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!lastStatus || typeof lastStatus.isLogin !== "boolean") {
        const error = new Error("NapCat worker restart status could not be verified");
        error.payload = { logout: result };
        throw error;
      }
      if (lastStatus.isLogin === true) {
        const error = new Error("NapCat worker restart did not clear the login state");
        error.payload = { logout: result, status: lastStatus };
        throw error;
      }
      return { ...result, workerRestarted: true };
    } catch (error) {
      if (!error.payload) error.payload = { logout: result };
      throw error;
    }
  }
  return result;
}

async function requestNapcatLoginCancel() {
  if (!isWebUiConfigured()) return;
  try {
    await webUiCall("/QQLogin/CancelLogin");
  } catch {
    // Some NapCat versions do not expose a cancel endpoint. Releasing the
    // local task is still sufficient; the next QR request refreshes it.
  }
}

async function cancelTask(task, reason = "任务已取消", { expired = false } = {}) {
  if (!task) return task;
  if (task.status === "success" && task.logoutStatus === "success" && task.released) {
    if (expired) {
      task.status = "expired";
      task.cancelled = true;
    }
    removeTaskAndLinks(task);
    return task;
  }
  if (task.kind === "napcat-login") {
    const linkedMiniTask = [...tasks.values()].find((candidate) =>
      candidate.kind === "miniapp-login" && candidate.loginTaskId === task.id && ["pending", "scanned"].includes(candidate.status)
    );
    if (linkedMiniTask) {
      if (linkedMiniTask.mode === "bridge" && linkedMiniTask.upstreamTaskId) {
        try {
          await bridgeCall(`${config.bridgeMiniCancelPath}/${encodeURIComponent(linkedMiniTask.upstreamTaskId)}`, { method: "POST" });
        } catch {
          // The linked bridge task may already be terminal.
        }
      }
      linkedMiniTask.status = expired ? "expired" : "cancelled";
      linkedMiniTask.cancelled = true;
      linkedMiniTask.error = reason;
      linkedMiniTask.released = true;
      linkedMiniTask.logoutStatus = "delegated";
      removeTaskFromCache(linkedMiniTask);
    }
  }
  const needsLogout = task.kind === "miniapp-login" || task.status === "success";
  if (task.kind === "miniapp-login" && task.mode === "bridge" && task.upstreamTaskId) {
    try {
      await bridgeCall(`${config.bridgeMiniCancelPath}/${encodeURIComponent(task.upstreamTaskId)}`, { method: "POST" });
    } catch {
      // The bridge task may already have completed; logout below remains the
      // authoritative release operation.
    }
  } else if (task.kind === "napcat-login" && !needsLogout) {
    await requestNapcatLoginCancel();
  }
  task.status = expired ? "expired" : "cancelled";
  task.cancelled = true;
  task.error = reason;
  if (task.expirationTimer) {
    clearTimeout(task.expirationTimer);
    task.expirationTimer = undefined;
  }
  if (!needsLogout) {
    task.released = true;
    task.logoutStatus = task.logoutStatus || "not_required";
    releaseWorkflow(task.ownerKey);
    removeTaskAndLinks(task);
    return task;
  }
  if (task.logoutPromise) return task.logoutPromise;
  task.logoutStatus = "pending";
  task.logoutPromise = (async () => {
    try {
      const result = await requestNapcatLogout(task.id);
      task.logoutStatus = "success";
      task.logoutMethod = result.method || "NodeIKernelLoginService.offline";
      task.released = true;
      logoutRecoveryRequired = false;
      const loginTask = task.loginTaskId && tasks.get(task.loginTaskId);
      if (loginTask) {
        loginTask.logoutStatus = "success";
        loginTask.logoutMethod = task.logoutMethod;
        loginTask.released = true;
      }
      releaseWorkflow(task.ownerKey);
    } catch (error) {
      task.logoutStatus = "failed";
      task.logoutError = error.message;
      task.released = false;
      logoutRecoveryRequired = true;
    } finally {
      task.logoutPromise = null;
      if (task.logoutStatus === "success" || expired) removeTaskAndLinks(task);
    }
    return task;
  })();
  return task.logoutPromise;
}

async function expireTaskIfNeeded(task) {
  if (!task || task.expiresAt > Date.now()) return task;
  if (task.status === "pending" || task.status === "scanned" || task.status === "success") {
    return cancelTask(task, "任务已超过 2 分钟，已自动取消并释放", { expired: true });
  }
  return task;
}

async function ensureLogoutRecovery() {
  if (!logoutRecoveryRequired) return;
  if (!logoutRecoveryPromise) {
    logoutRecoveryPromise = (async () => {
      try {
        const result = await requestNapcatLogout("recovery");
        logoutRecoveryRequired = false;
        for (const task of tasks.values()) {
          if (task.logoutStatus === "failed") {
            task.logoutStatus = "success";
            task.logoutMethod = result.method || "NodeIKernelLoginService.offline";
            task.logoutError = undefined;
            task.released = true;
          }
        }
        releaseWorkflow();
      } catch (error) {
        // NapCat 已经没登录、OneBot 上下文不可用时，本地不需要再注销，放行下一位扫码。
        const detail = `${error.message || ""} ${JSON.stringify(error.payload || {})}`;
        const alreadyLoggedOut = /OneBot context not available|not logged in|LOGIN_REQUIRED|isLogin[^;]*false/i.test(detail);
        if (alreadyLoggedOut) {
          logoutRecoveryRequired = false;
          for (const task of tasks.values()) {
            if (task.logoutStatus === "failed") {
              task.logoutStatus = "success";
              task.logoutMethod = "already_logged_out";
              task.logoutError = undefined;
              task.released = true;
            }
          }
          releaseWorkflow();
        } else {
          const wrapped = new Error(`上一次 QQ 自动注销失败，无法开始下一位用户：${error.message}`);
          wrapped.status = 503;
          wrapped.code = "LOGOUT_REQUIRED";
          wrapped.payload = error.payload;
          throw wrapped;
        }
      } finally {
        logoutRecoveryPromise = null;
      }
    })();
  }
  return logoutRecoveryPromise;
}

async function finalizeMiniappTask(task) {
  if (!task || task.status !== "success" || !task.code) return task;
  if (["success", "failed"].includes(task.logoutStatus)) return task;
  if (task.logoutPromise) return task.logoutPromise;
  task.logoutStatus = "pending";
  task.logoutPromise = (async () => {
    try {
      const result = await requestNapcatLogout(task.id);
      task.logoutStatus = "success";
      task.logoutMethod = result.method || "NodeIKernelLoginService.offline";
      task.released = true;
      logoutRecoveryRequired = false;
      const loginTask = task.kind === "napcat-login" ? task : task.loginTaskId && tasks.get(task.loginTaskId);
      if (loginTask) {
        loginTask.logoutStatus = "success";
        loginTask.logoutMethod = task.logoutMethod;
        loginTask.released = true;
      }
    } catch (error) {
      task.logoutStatus = "failed";
      task.logoutError = error.message;
      task.released = false;
      logoutRecoveryRequired = true;
    } finally {
      if (task.logoutStatus === "success") releaseWorkflow(task.ownerKey);
      task.logoutPromise = null;
    }
    return task;
  })();
  return task.logoutPromise;
}

async function miniappStatus(task) {
  await expireTaskIfNeeded(task);
  if (task.status === "pending" && task.mode === "bridge") {
    try {
      const result = await bridgeCall(`${config.bridgeMiniStatusPath}/${encodeURIComponent(task.upstreamTaskId || task.id)}`);
      task.status = result.code ? "success" : mapStatus(result);
      task.code = result.code || task.code;
      task.user = result.user || task.user;
      task.nickname = extractUserNickname(result.nickname !== undefined ? result.nickname : result.user) || task.nickname;
      task.qrUrl = result.qrUrl || result.qr_url || task.qrUrl;
      task.qrImage = result.qrImage || result.qr_image || task.qrImage;
      task.error = result.error || result.message;
    } catch (error) {
      task.error = error.message;
    }
  }
  if (task.status === "success" && !task.code) {
    task.status = "failed";
    task.error = "Bridge reported success without an authorization code";
  }
  if (task.status === "success") await finalizeMiniappTask(task);
  else if (["expired", "cancelled"].includes(task.status) && !task.logoutStatus) {
    await cancelTask(task, task.error || "小程序授权任务已取消", { expired: task.status === "expired" });
  } else if (["failed", "expired", "cancelled", "login_required"].includes(task.status) && !["pending", "failed"].includes(task.logoutStatus)) {
    releaseWorkflow(task.ownerKey);
  }
  return task;
}

async function currentUser() {
  try {
    return await napcatCall("get_login_info");
  } catch (onebotError) {
    if (!isWebUiConfigured()) throw onebotError;
    return webUiCall("/QQLogin/GetQQLoginInfo");
  }
}

async function exchangeMiniappCode(body) {
  const { appId, code } = body || {};
  if (!validAppId(appId) || typeof code !== "string" || code.length < 1) {
    const error = new Error("appId and code are required");
    error.status = 400;
    throw error;
  }
  const secret = config.miniappSecrets[appId];
  if (!secret) {
    const error = new Error("No server-side secret configured for this appId");
    error.status = 400;
    throw error;
  }
  const endpoint = new URL("https://api.q.qq.com/sns/jscode2session");
  endpoint.searchParams.set("appid", appId);
  endpoint.searchParams.set("secret", secret);
  endpoint.searchParams.set("js_code", code);
  endpoint.searchParams.set("grant_type", "authorization_code");
  return requestJson(endpoint.toString());
}

async function parseBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 400 });
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  };
  if (config.corsOrigin && config.corsOrigin !== "same-origin") {
    headers["Access-Control-Allow-Origin"] = config.corsOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(body);
}

function taskForRequest(taskId, kind) {
  const task = tasks.get(taskId);
  if (!task || (kind && task.kind !== kind)) {
    const error = new Error("Task not found or expired");
    error.status = 404;
    error.code = "TASK_EXPIRED";
    error.task = expiredTaskPayload(taskId, kind === "napcat-login" ? "qq-login" : kind === "miniapp-login" ? "miniapp-code" : undefined);
    throw error;
  }
  return task;
}

function miniTaskForRequest(taskId) {
  const task = tasks.get(taskId);
  if (task?.kind === "miniapp-login") return task;
  if (task?.kind === "napcat-login") {
    const linked = [...tasks.values()].find((candidate) => candidate.kind === "miniapp-login" && candidate.loginTaskId === taskId);
    if (linked) return linked;
  }
  const error = new Error("Mini-app task not found");
  error.status = 404;
  throw error;
}

function apiTaskPayload(task, ok = taskResponseOk(task)) {
  const payload = { ok, task: publicTask(task) };
  if (!ok && task?.status === "expired") {
    payload.code = "TASK_EXPIRED";
    payload.error = task.error || "Task expired";
  }
  return payload;
}

function miniappOperationPayload(task) {
  if (!task) return { ok: false, code: "TASK_EXPIRED", status: "expired" };
  if (task.status === "success" && task.code && task.logoutStatus === "success") {
    return {
      ok: true,
      code: task.code,
      ...(task.nickname ? { nickname: task.nickname } : {})
    };
  }
  if (task.status === "success" && task.logoutStatus === "failed") {
    return { ok: false, code: "LOGOUT_FAILED", status: "failed", error: task.logoutError || "QQ logout failed" };
  }
  if (task.status === "expired") {
    return { ok: false, code: "TASK_EXPIRED", status: "expired", error: task.error || "Task expired" };
  }
  return {
    ok: false,
    status: task.status,
    code: task.status === "login_required" ? "LOGIN_REQUIRED" : "MINIAPP_FAILED",
    error: task.error || "Mini-app authorization failed"
  };
}

function logoutOperationPayload(task) {
  if (!task || task.status === "expired") {
    return { ok: false, code: "TASK_EXPIRED", status: "expired", error: task?.error || "Task not found or expired" };
  }
  if (task.logoutStatus === "failed") {
    return { ok: false, code: "LOGOUT_FAILED", status: task.status, error: task.logoutError || "QQ logout failed" };
  }
  return { ok: true };
}

function operationErrorPayload(error) {
  if (error?.code === "TASK_EXPIRED" || error?.task?.status === "expired") {
    return { ok: false, code: "TASK_EXPIRED", status: "expired", error: error.message || "Task not found or expired" };
  }
  const payload = { ok: false, error: error?.message || "Request failed" };
  if (error?.code) payload.code = error.code;
  if (error?.task?.status) payload.status = error.task.status;
  return payload;
}

async function waitForMiniappTask(task, timeoutMs = config.taskTtlMs) {
  const deadline = Date.now() + timeoutMs;
  while (task.status === "pending" && Date.now() < deadline) {
    await miniappStatus(task);
    if (task.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (task.status === "pending") {
    await cancelTask(task, "授权任务等待超时，已自动取消", { expired: true });
    task.error = "授权任务等待超时，请重新请求";
  }
  return task;
}

async function route(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const method = request.method || "GET";
  try {
    if (method === "OPTIONS") {
      const headers = {
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Signature",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
      };
      if (config.corsOrigin && config.corsOrigin !== "same-origin") {
        headers["Access-Control-Allow-Origin"] = config.corsOrigin;
        headers["Access-Control-Allow-Credentials"] = "true";
      }
      response.writeHead(200, headers);
      response.end();
      return;
    }
    if (requiresApiSignature(url.pathname)) {
      const auth = verifyApiSignature(request);
      if (!auth.ok) {
        sendJson(response, 200, auth);
        return;
      }
    }
    if (url.pathname === "/api/health" && method === "GET") {
      sendJson(response, 200, {
        ok: true,
        napcatConfigured: Boolean(config.napcatApiUrl),
        webUiConfigured: isWebUiConfigured(),
        qrFileConfigured: Boolean(readNapcatQrImage()),
        bridgeConfigured: Boolean(config.bridgeUrl),
        workflowBusy: Boolean(expireWorkflowIfNeeded()),
        workflowPhase: expireWorkflowIfNeeded()?.phase,
        workflowExpiresAt: expireWorkflowIfNeeded()?.expiresAt,
        logoutRecoveryRequired,
        qrHealth: {
          consecutiveFailures: qrHealth.consecutiveFailures,
          successfulCodes: qrHealth.successfulCodes,
          codesSinceReinit: qrHealth.codesSinceReinit,
          reinitThreshold: config.qrReinitThreshold,
          reinitializing: Boolean(qrHealth.reinitInFlight),
          resetting: Boolean(qrHealth.resetInFlight),
          resetPending: Boolean(qrHealth.resetPending),
          softResets: qrHealth.softResets,
          proactiveResets: qrHealth.proactiveResets,
          lastSoftResetAt: qrHealth.lastSoftResetAt || undefined,
          lastReinitAt: qrHealth.lastReinitAt || undefined,
          lastReinitResult: qrHealth.lastReinitResult || undefined,
          stuckWorkflows: qrHealth.stuckWorkflows,
        },
      });
      return;
    }
    // 手动触发：立即重启 NapCat 内核并等就绪（面板/运维脚本可直接调）。
    if (url.pathname === "/api/qq/reinit" && method === "POST") {
      // 先轻量重置（清孤儿任务/工作流/凭证 + 重刷码），内核确实没救才重启 NapCat。
      const result = await initializeQrLogin("手动请求");
      sendJson(response, 200, { ok: Boolean(result.coreReady), ...result });
      return;
    }
    if (url.pathname === "/api/qq/login/qrcode" && method === "POST") {
      sendJson(response, 200, apiTaskPayload(await loginStart()));
      return;
    }
    if (["/api/qq/login/status", "/api/qq/login/status/"].includes(url.pathname) && method === "POST") {
      const body = await parseBody(request);
      const task = taskForRequest(body.taskId, "napcat-login");
      const refresh = body.refresh === true || body.refresh === "true";
      const result = refresh ? await refreshLogin(task) : await loginStatus(task);
      sendJson(response, 200, apiTaskPayload(result));
      return;
    }
    if (url.pathname === "/api/qq/miniapp/code" && method === "POST") {
      const body = await parseBody(request);
      const taskId = body.taskId || body.loginTaskId;
      const existing = tasks.get(taskId);
      const task = existing?.kind === "miniapp-login" ? await miniappStatus(existing) : await miniappStart(body.appId, taskId);
      await waitForMiniappTask(task);
      const payload = miniappOperationPayload(task);
      if (!payload.ok) {
        console.error(`[miniapp] task=${task.id} status=${task.status} code=${payload.code || ""} error=${payload.error || ""} logoutStatus=${task.logoutStatus || ""} logoutError=${task.logoutError || ""}`);
      } else {
        console.log(`[miniapp] task=${task.id} ok nickname=${payload.nickname || ""} codeLen=${String(payload.code || "").length}`);
      }
      if (["success", "expired", "failed", "cancelled", "login_required"].includes(task.status)) removeTaskAndLinks(task);
      sendJson(response, 200, payload);
      return;
    }
    if (url.pathname === "/api/qq/logout" && method === "POST") {
      const body = await parseBody(request);
      const taskId = body.taskId || body.loginTaskId;
      const task = taskForRequest(taskId);
      if (task.status === "expired") removeTaskFromCache(task);
      else await cancelTask(task, "QQ 已注销，任务已释放");
      sendJson(response, 200, logoutOperationPayload(task));
      return;
    }
    sendJson(response, url.pathname.startsWith("/api/") ? 200 : 404, { ok: false, error: "Not found" });
  } catch (error) {
    if (url.pathname === "/api/qq/miniapp/code" || url.pathname === "/api/qq/logout") {
      sendJson(response, 200, operationErrorPayload(error));
      return;
    }
    const payload = { ok: false, error: error.message || "Request failed" };
    if (error.code) payload.code = error.code;
    if (error.task) payload.task = error.task;
    // 可重试等待时间：前端用它做倒计时（WORKFLOW_BUSY / 内核重初始化都带）。
    const retryAfterMs = Number(error.retryAfterMs ?? error.payload?.retryAfterMs);
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) payload.retryAfterMs = Math.round(retryAfterMs);
    if (error.payload?.phase) payload.phase = error.payload.phase;
    if (error.reinitAttempted) payload.reinitAttempted = true;
    sendJson(response, url.pathname.startsWith("/api/") ? 200 : (Number.isInteger(error.status) ? error.status : 502), payload);
  }
}

export function createServer() {
  return http.createServer((request, response) => {
    route(request, response);
  });
}

const cleanupTimer = setInterval(() => {
  for (const task of tasks.values()) {
    if (task.expiresAt <= Date.now() && ["pending", "scanned", "success"].includes(task.status)) {
      void expireTaskIfNeeded(task);
    }
  }
  expireWorkflowIfNeeded();
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, task] of tasks) {
    if (task.expiresAt < cutoff || task.createdAt < cutoff) {
      if (task.expirationTimer) clearTimeout(task.expirationTimer);
      tasks.delete(id);
    }
  }
}, 60_000);
cleanupTimer.unref();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  createServer().listen(config.port, config.host, () => {
    console.log(`qq-miniapp-auth listening at http://${config.host}:${config.port}`);
    console.log(`NapCat API: ${config.napcatApiUrl}`);
    console.log(`Bridge: ${config.bridgeUrl || "not configured"}`);
  });
}

export { config, validAppId, normalizeBridgeResult };
