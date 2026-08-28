import { t, useLocale } from "../../i18n";
import { isActiveStatus } from "../../lib/format";
import type { ListFilter } from "../../lib/types";
import { useAppStore } from "../../store/appStore";
import { FilterTab } from "../ui/FilterTab";

const FILTERS: Array<{ key: ListFilter; labelKey: string }> = [
  { key: "all", labelKey: "nav.all" },
  { key: "active", labelKey: "nav.active" },
  { key: "completed", labelKey: "nav.completed" },
  { key: "history", labelKey: "nav.history" },
];

export function FilterBar() {
  const tasks = useAppStore((state) => state.tasks);
  const filter = useAppStore((state) => state.filter);
  const setFilter = useAppStore((state) => state.setFilter);
  const locale = useLocale();

  const counts: Partial<Record<ListFilter, number>> = {
    all: tasks.length,
    active: tasks.filter((task) => isActiveStatus(task.status)).length,
    completed: tasks.filter((task) => task.status === "completed").length,
  };

  return (
    <div className="filter-bar" role="group" aria-label={t("filter.label", locale)}>
      {FILTERS.map((item) => (
        <FilterTab
          key={item.key}
          label={t(item.labelKey, locale)}
          count={counts[item.key]}
          selected={filter === item.key}
          onSelect={() => setFilter(item.key)}
        />
      ))}
    </div>
  );
}
