const TARGETS = new Set(["macos-arm64", "windows-x64"]);
const ANONYMOUS_OUTCOMES = new Set(["authentication_required", "downloaded", "unverified"]);
const RESTRICTIONS = new Set(["registered_users", "age_confirmation"]);
const CREDENTIAL_SOURCES = new Set(["browser", "cookiefile"]);
const CASE_ID = /^(?:youtube|bilibili|douyin)-(?:0[1-9]|10)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_PAIR_AGE_MS = 3 * 60 * 60 * 1000;

// Cookie 帮助尾缀不是读取失败；Bilibili 的业务码 -403 也不是 HTTP 403。
const DISQUALIFYING_ERROR = new RegExp([
  "fresh\\s+cookies",
  "(?:http(?:\\s*error|/\\d(?:\\.\\d)?)?|status(?:\\s+code)?)\\s*[:=]?\\s*(?:403|429|5\\d\\d)\\b|403\\s+forbidden|429\\s+too\\s+many",
  "timed?\\s*out|timeout|network|connection|\\b(?:ssl|tls)\\b|certificate|proxy|econn|enet|ehost|enotfound|eai_again",
  "\\[errno\\s+-?\\d+\\]|\\bincompleteread\\b|\\b\\d+\\s+bytes\\s+read(?:,\\s*\\d+\\s+more\\s+expected)?",
  "captcha|\\bbot\\b|robot|verification\\s+challenge|verifycenter|(?:verify|confirm).*\\b(?:human|person)\\b|机器人|人机|验证码|滑块|安全验证",
  "rate[ -]?limit|po[ _-]?token|gvs[ _-]?po",
  "cookieloaderror|dpapi|decrypt|database\\s+is\\s+locked|(?:cookie|cookies).*(?:database|locked)|(?:copy|load|read).*(?:cookie|cookies).*(?:fail|error)",
  "(?:failed|unable|could\\s+not|cannot|can't)\\s+(?:to\\s+)?(?:read|load|extract|copy|open).*cookies?|permission\\s+denied.*cookies?|cookies?.*permission\\s+denied",
  "only\\s+preview\\s+format",
].join("|"), "i");

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value) => typeof value === "string" && SHA256.test(value);
const isInstanceId = (value) => typeof value === "string" && UUID.test(value);

function isTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** 仅检查匿名任务最终错误；不从预取日志或宽泛 need_login 推导素材资格。 */
export function classifyAnonymousLoginTask(task) {
  if (task?.status === "completed") return { outcome: "downloaded", restriction: "none" };
  const unverified = { outcome: "unverified", restriction: "none" };
  if (task?.status !== "failed" || task.error_code !== "need_login" ||
      typeof task.error_message !== "string") return unverified;
  const message = task.error_message;
  if (DISQUALIFYING_ERROR.test(message)) return unverified;
  // yt-dlp common.raise_login_required 的默认原句，BiliBili 普通视频明确调用。
  if (/\bthis video is only available for registered users\b/i.test(message)) {
    return { outcome: "authentication_required", restriction: "registered_users" };
  }
  // 最终年龄确认错误；不接受“可能缺少部分格式”的 age-restricted 日志。
  if (/\bsign in to confirm your age\b/i.test(message)) {
    return { outcome: "authentication_required", restriction: "age_confirmation" };
  }
  return unverified;
}

/** 仅复制固定枚举、合规时间、UUID 和哈希；不强制转换任何原始字段。 */
export function sanitizeLoginEvidence(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.source !== "paired-candidate-runs" ||
      typeof value.caseId !== "string" || !CASE_ID.test(value.caseId) ||
      !TARGETS.has(value.target) || !isHash(value.candidateSha256) || !isHash(value.sampleSha256)) return undefined;
  const anonymous = value.anonymous;
  if (!isRecord(anonymous) || anonymous.credentialSource !== "none" ||
      !isInstanceId(anonymous.instanceId) || !ANONYMOUS_OUTCOMES.has(anonymous.outcome) ||
      !isTimestamp(anonymous.recordedAt)) return undefined;
  if (anonymous.outcome === "authentication_required"
    ? !RESTRICTIONS.has(anonymous.restriction)
    : anonymous.restriction !== "none") return undefined;

  let authorized = null;
  if (value.authorized !== null) {
    const attempt = value.authorized;
    if (!isRecord(attempt) || !CREDENTIAL_SOURCES.has(attempt.credentialSource) ||
        !isInstanceId(attempt.instanceId) || !isTimestamp(attempt.recordedAt)) return undefined;
    authorized = {
      credentialSource: attempt.credentialSource,
      instanceId: attempt.instanceId,
      recordedAt: attempt.recordedAt,
      ...(isHash(attempt.artifactSha256) ? { artifactSha256: attempt.artifactSha256 } : {}),
    };
  }

  return {
    schemaVersion: 1,
    source: "paired-candidate-runs",
    caseId: value.caseId,
    target: value.target,
    candidateSha256: value.candidateSha256,
    sampleSha256: value.sampleSha256,
    anonymous: {
      credentialSource: "none",
      instanceId: anonymous.instanceId,
      outcome: anonymous.outcome,
      restriction: anonymous.restriction,
      recordedAt: anonymous.recordedAt,
    },
    authorized,
  };
}

/** 配对记录仅防止证据错配，不把可编辑 JSON 当作防篡改凭证。 */
export function evaluateLoginEvidence(result) {
  if (!isRecord(result)) return false;
  const evidence = sanitizeLoginEvidence(result.loginEvidence);
  if (!evidence || !evidence.authorized || evidence.anonymous.outcome !== "authentication_required") return false;
  if (evidence.caseId !== result.id || evidence.target !== result.target || evidence.candidateSha256 !== result.candidateSha256 ||
      evidence.sampleSha256 !== result.sampleSha256) return false;
  if (result.outcome !== "completed" || result.artifactPlayable !== true || !isHash(result.artifactSha256) ||
      evidence.authorized.artifactSha256 !== result.artifactSha256 ||
      !Number.isSafeInteger(result.artifactBytes) || result.artifactBytes <= 0) return false;
  if (evidence.anonymous.instanceId.toLowerCase() === evidence.authorized.instanceId.toLowerCase() ||
      evidence.authorized.recordedAt !== result.recordedAt) return false;
  const elapsed = Date.parse(evidence.authorized.recordedAt) - Date.parse(evidence.anonymous.recordedAt);
  return elapsed > 0 && elapsed <= MAX_PAIR_AGE_MS;
}
