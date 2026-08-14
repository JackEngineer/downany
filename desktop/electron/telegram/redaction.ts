const SECRET_KEYS = /(token|secret|password|authorization|api[_-]?hash|api[_-]?id)/i;

export function redactTelegramSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\b\d{5,20}:[A-Za-z0-9_-]{20,}\b/g, "<redacted-token>")
      .replace(/(Authorization\s*:\s*Bearer\s+)[^\s]+/gi, "$1<redacted>");
  }
  if (Array.isArray(value)) return value.map(redactTelegramSecrets);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SECRET_KEYS.test(key) ? "<redacted>" : redactTelegramSecrets(item);
    }
    return result;
  }
  return value;
}

export function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactTelegramSecrets(message));
}
