export interface FilterTabProps {
  label: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}

export function FilterTab({
  label,
  count,
  selected,
  onSelect,
}: FilterTabProps) {
  const accessibleName =
    typeof count === "number" ? `${label} ${count}` : label;

  return (
    <button
      type="button"
      className="ui-filter-tab"
      aria-pressed={selected}
      aria-label={accessibleName}
      onClick={onSelect}
    >
      <span>{label}</span>
      {typeof count === "number" ? (
        <span className="ui-filter-tab__count">{count}</span>
      ) : null}
      <span className="ui-filter-tab__indicator" aria-hidden="true" />
    </button>
  );
}
