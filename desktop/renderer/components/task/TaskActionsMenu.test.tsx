import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { taskFixture } from "../../test/taskFixture";
import { buildTaskContextTemplate } from "./TaskActionsMenu";

afterEach(cleanup);

describe("priority menu scope", () => {
  it.each([[0, "将合集设为高优先级"], [1, "取消合集高优先级"]])(
    "explains that changing a grouped child's priority affects the whole group (%s)",
    (priority, label) => {
      const items = buildTaskContextTemplate(taskFixture({ group_id: "group", priority: Number(priority) }));
      expect(items.find((item) => item.id?.startsWith("priority-"))?.label).toBe(label);
    },
  );

  it("permits priority changes on a cancelled task before retry", () => {
    const items = buildTaskContextTemplate(taskFixture({ status: "cancelled" }));
    expect(items.find((item) => item.id === "priority-high")?.label).toBe("设为高优先级");
  });

  it("does not offer priority changes for a completed result", () => {
    const items = buildTaskContextTemplate(taskFixture({ status: "completed" }));
    expect(items.some((item) => item.id?.startsWith("priority-"))).toBe(false);
  });
});
