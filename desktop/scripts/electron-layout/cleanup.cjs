function describeFailure(label, cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(`清理步骤「${label}」失败: ${reason}`, { cause });
}

async function runBestEffortCleanup(steps) {
  const failures = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      failures.push(describeFailure(step.label, cause));
    }
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `${failures.length} 个清理步骤失败`);
  }
}

module.exports = { runBestEffortCleanup };
