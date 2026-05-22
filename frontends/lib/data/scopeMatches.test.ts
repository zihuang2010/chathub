import { describe, expect, it } from "vitest";

import { scopeMatches, type ChangeScope } from "./types";

describe("scopeMatches", () => {
  const emp = (employeeId: string, rest: Partial<ChangeScope> = {}): ChangeScope => ({
    employeeId,
    ...rest,
  });

  it("rejects different employee_id", () => {
    expect(scopeMatches(emp("u-A"), emp("u-B"))).toBe(false);
  });

  it("matches when both scopes are employee-only", () => {
    expect(scopeMatches(emp("u-1"), emp("u-1"))).toBe(true);
  });

  it("notice with broader scope matches subscription with narrower scope", () => {
    // notice 影响全员 → 订阅特定 account 也该被通知
    expect(scopeMatches(emp("u-1"), emp("u-1", { wecomAccountId: "wa-1" }))).toBe(true);
  });

  it("notice with specific scope matches subscription scoped to same account", () => {
    expect(
      scopeMatches(emp("u-1", { wecomAccountId: "wa-1" }), emp("u-1", { wecomAccountId: "wa-1" })),
    ).toBe(true);
  });

  it("notice with specific scope does NOT match different specific subscription", () => {
    // wa-1 的 notice 不应触发 wa-2 的订阅(scope match 的核心价值)
    expect(
      scopeMatches(emp("u-1", { wecomAccountId: "wa-1" }), emp("u-1", { wecomAccountId: "wa-2" })),
    ).toBe(false);
  });

  it("notice with specific account matches subscription without account filter", () => {
    // 订阅"全部账号" → wa-1 事件应被通知
    expect(scopeMatches(emp("u-1", { wecomAccountId: "wa-1" }), emp("u-1"))).toBe(true);
  });

  it("multi-dimension scope: conversationId mismatch rejects", () => {
    expect(
      scopeMatches(emp("u-1", { conversationId: "cv-A" }), emp("u-1", { conversationId: "cv-B" })),
    ).toBe(false);
  });

  it("multi-dimension scope: all matching dimensions returns true", () => {
    expect(
      scopeMatches(
        emp("u-1", { wecomAccountId: "wa-1", conversationId: "cv-A" }),
        emp("u-1", { wecomAccountId: "wa-1", conversationId: "cv-A" }),
      ),
    ).toBe(true);
  });
});
