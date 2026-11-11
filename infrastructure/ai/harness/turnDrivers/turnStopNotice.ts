/**
 * Explains why an agent turn stopped while the task was still open.
 *
 * The Catty loop uses `stopWhen: isStepCount(maxIterations)` and the model can
 * also hit its per-turn output cap. Neither case surfaces an error: the turn
 * just ends, which reads as "finished" in the transcript. Returning a notice
 * lets the assistant message say what actually happened.
 */
export interface TurnStopNoticeInput {
  completedSteps: number;
  maxIterations: number;
  finishReason?: string;
  language?: string;
}

export function buildTurnStopNotice(input: TurnStopNoticeInput): string | null {
  const truncated = input.finishReason === "length";
  const stepLimited =
    !truncated
    && Number.isFinite(input.maxIterations)
    && input.maxIterations > 0
    && input.completedSteps >= input.maxIterations;
  if (!truncated && !stepLimited) return null;

  const chinese = (input.language ?? "en").toLowerCase().startsWith("zh");
  if (truncated) {
    return chinese
      ? "\n\n---\n⚠️ 模型单次输出已达长度上限，回答被截断。回复「继续」即可接着做。"
      : "\n\n---\n⚠️ The model hit its per-turn output limit, so this answer was cut off. Reply \"continue\" to keep going.";
  }
  return chinese
    ? `\n\n---\n⏸ 本回合已达到 ${input.maxIterations} 步上限，任务可能没做完。回复「继续」可以接着做，或在 设置 → AI → 安全 调高「最大迭代次数」。`
    : `\n\n---\n⏸ This turn reached its ${input.maxIterations}-step budget, so it stopped before the task was finished. Reply "continue" to keep going, or raise Settings → AI → Safety → Max iterations.`;
}
