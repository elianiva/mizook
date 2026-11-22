import type { Part } from "./core.ts";

/** One row of list data: a bare string, an option, a separator, or a labelled group of rows. */
export type Entry =
  | string
  | Readonly<{ value: string; label: string; disabled?: boolean }>
  | Readonly<{ type: "separator" }>
  | Readonly<{ type: "group"; label?: string; items: ReadonlyArray<Entry> }>;

/** The parts of a list component that render data. `item-text` is used when the component has one. */
export type ListParts<AppMessage> = Readonly<{
  item: Part<AppMessage>;
  group: Part<AppMessage>;
  "group-label": Part<AppMessage>;
  separator: Part<AppMessage>;
  "item-text"?: Part<AppMessage>;
}>;

type Html = ReturnType<Part<never>>;

/** Every option in the data, groups flattened. This is what a component's `items` option holds. */
export const flattenEntries = (
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Readonly<{ value: string; label: string }>> =>
  entries.flatMap((entry) =>
    typeof entry === "string"
      ? [{ value: entry, label: entry }]
      : "type" in entry
        ? entry.type === "group"
          ? flattenEntries(entry.items)
          : []
        : [{ value: entry.value, label: entry.label }],
  );

/**
 * Renders list data with the component's parts: an item per option, a group with its
 * label, a separator. Pass already filtered data to filter. A group with no rows left is dropped.
 */
export const listItems = <AppMessage>(
  parts: ListParts<AppMessage>,
  entries: ReadonlyArray<Entry>,
  group?: string,
): ReadonlyArray<Html> =>
  entries.flatMap((entry, index): ReadonlyArray<Html> => {
    const within = group === undefined ? {} : { group };
    if (typeof entry !== "string" && "type" in entry) {
      if (entry.type === "separator") return [parts.separator({ index }, [], [])];
      const name = entry.label ?? `group-${index}`;
      const rows = listItems(parts, entry.items, name);
      if (rows.length === 0) return [];
      return [
        parts.group(
          { group: name },
          [],
          [
            ...(entry.label === undefined
              ? []
              : [parts["group-label"]({ group: name }, [], [entry.label])]),
            ...rows,
          ],
        ),
      ];
    }
    const option = typeof entry === "string" ? { value: entry, label: entry } : entry;
    const props = {
      ...within,
      value: option.value,
      label: option.label,
      ...("disabled" in option && option.disabled === true ? { disabled: true } : {}),
    };
    const text = parts["item-text"];
    return [
      parts.item(
        props,
        [],
        [text ? text({ text: option.label }, [], [option.label]) : option.label],
      ),
    ];
  });
