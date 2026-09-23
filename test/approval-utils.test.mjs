import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUserInputResult,
  defaultApprovalResult,
  toGrantedPermissions,
} from "../public/approval-utils.js";

test("serializes structured approval answers and validates missing questions", () => {
  const questions = [
    { id: "choice", header: "方案" },
    { id: "secret", header: "密钥", isSecret: true },
  ];
  assert.deepEqual(
    buildUserInputResult(questions, { choice: ["方案 B"], secret: ["token"] }),
    {
      answers: {
        choice: { answers: ["方案 B"] },
        secret: { answers: ["token"] },
      },
    },
  );
  assert.throws(
    () => buildUserInputResult(questions, { choice: ["方案 B"] }),
    (error) => error.questionIndex === 1 && /密钥/.test(error.message),
  );
});

test("grants only concrete requested permission sections", () => {
  const fileSystem = { read: ["/tmp/input"], write: ["/tmp/output"], entries: [] };
  assert.deepEqual(
    toGrantedPermissions({ network: { enabled: true }, fileSystem }),
    { network: { enabled: true }, fileSystem },
  );
  assert.deepEqual(toGrantedPermissions({ network: null, fileSystem: null }), {});
});

test("provides schema-valid safe defaults for advanced and legacy requests", () => {
  assert.deepEqual(
    JSON.parse(defaultApprovalResult("mcpServer/elicitation/request")),
    { action: "decline", content: null, _meta: null },
  );
  assert.deepEqual(
    JSON.parse(defaultApprovalResult("execCommandApproval")),
    { decision: { denied: { rejection: "用户拒绝了此操作。" } } },
  );
});
