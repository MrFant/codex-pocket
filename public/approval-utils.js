export function toGrantedPermissions(requestedPermissions) {
  const requested = requestedPermissions && typeof requestedPermissions === "object"
    ? requestedPermissions
    : {};
  const granted = {};
  if (requested.network && typeof requested.network === "object") {
    granted.network = requested.network;
  }
  if (requested.fileSystem && typeof requested.fileSystem === "object") {
    granted.fileSystem = requested.fileSystem;
  }
  return granted;
}

export function buildUserInputResult(questions, draftAnswers) {
  const answers = {};
  for (const [questionIndex, question] of (questions || []).entries()) {
    const questionId = String(question.id || `question-${questionIndex + 1}`);
    const values = draftAnswers?.[questionId];
    if (!Array.isArray(values) || values.length === 0 || !String(values[0]).trim()) {
      const error = new Error(`请先回答“${question.header || question.question || `问题 ${questionIndex + 1}`}”`);
      error.questionIndex = questionIndex;
      throw error;
    }
    answers[questionId] = { answers: values };
  }
  return { answers };
}

export function defaultApprovalResult(method = "") {
  if (method.includes("requestUserInput")) return JSON.stringify({ answers: {} }, null, 2);
  if (method.includes("permissions")) return JSON.stringify({ permissions: {}, scope: "turn" }, null, 2);
  if (method.includes("commandExecution") || method.includes("fileChange")) {
    return JSON.stringify({ decision: "decline" }, null, 2);
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return JSON.stringify({ decision: { denied: { rejection: "用户拒绝了此操作。" } } }, null, 2);
  }
  if (method.includes("elicitation")) {
    return JSON.stringify({ action: "decline", content: null, _meta: null }, null, 2);
  }
  return JSON.stringify({}, null, 2);
}
