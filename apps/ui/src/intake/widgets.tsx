/**
 * widgets — the 7 dumb/controlled intake field widgets (FRONTEND_LAYOUT §5.2).
 * Each is a pure controlled input that takes a typed value + onChange + invalid
 * state; no widget reaches the store or the network. A single hand-written switch
 * maps a FieldDescriptor.widget to its component (no generic JSON-Schema→React
 * renderer; §5.2). Every assertable node carries a stable data-testid keyed by the
 * field name (M3 ui_checks depend on these).
 */

import { allowedYears, type FieldDescriptor } from "./formModel.js";

export interface WidgetProps {
  desc: FieldDescriptor;
  value: unknown;
  invalid: boolean;
  describedById: string | undefined;
  onChange: (value: unknown) => void;
  onBlur: () => void;
}

const testId = (name: string): string => `intake-field-${name}`;

function TextLikeInput({
  desc,
  value,
  invalid,
  describedById,
  onChange,
  onBlur,
  type,
}: WidgetProps & { type: "text" | "email" | "tel" | "number" }): JSX.Element {
  return (
    <input
      type={type}
      name={desc.name}
      data-testid={testId(desc.name)}
      value={value === null || value === undefined ? "" : String(value)}
      placeholder={desc.placeholder}
      aria-invalid={invalid}
      aria-describedby={describedById}
      onChange={(e) => {
        const raw = e.target.value;
        if (type === "number") {
          onChange(raw.trim() === "" ? null : /^-?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw);
        } else {
          onChange(raw === "" ? (desc.meta.required ? "" : null) : raw);
        }
      }}
      onBlur={onBlur}
    />
  );
}

/** year-segmented: a radio pair for [now, now+1] (constraint current-or-next). */
function YearSegmented({ desc, value, invalid, describedById, onChange, onBlur }: WidgetProps): JSX.Element {
  const [y0, y1] = allowedYears();
  return (
    <div
      className="radiogroup"
      role="radiogroup"
      aria-invalid={invalid}
      aria-describedby={describedById}
      data-testid={testId(desc.name)}
    >
      {[y0, y1].map((y) => (
        <label key={y}>
          <input
            type="radio"
            name={desc.name}
            value={y}
            data-testid={`${testId(desc.name)}-${y}`}
            checked={value === y}
            onChange={() => onChange(y)}
            onBlur={onBlur}
          />
          {y}
        </label>
      ))}
    </div>
  );
}

/** segmented: enum radios; optionLabels override; a null→"Any" choice when the
 *  field is optional (so an optional enum can be cleared). */
function SegmentedEnum({ desc, value, invalid, describedById, onChange, onBlur }: WidgetProps): JSX.Element {
  const options = desc.options ?? [];
  return (
    <div
      className="radiogroup"
      role="radiogroup"
      aria-invalid={invalid}
      aria-describedby={describedById}
      data-testid={testId(desc.name)}
    >
      {!desc.meta.required && (
        <label>
          <input
            type="radio"
            name={desc.name}
            value=""
            data-testid={`${testId(desc.name)}-any`}
            checked={value === null || value === undefined}
            onChange={() => onChange(null)}
            onBlur={onBlur}
          />
          Any
        </label>
      )}
      {options.map((o) => (
        <label key={o.value}>
          <input
            type="radio"
            name={desc.name}
            value={o.value}
            data-testid={`${testId(desc.name)}-${o.value}`}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            onBlur={onBlur}
          />
          {o.label}
        </label>
      ))}
    </div>
  );
}

/** boolean-int: a checkbox serialized to 0|1 (null when never touched is fine —
 *  the field is optional; an unchecked box reads 0 only once interacted). */
function BooleanIntToggle({ desc, value, onChange, onBlur }: WidgetProps): JSX.Element {
  return (
    <label className="radiogroup">
      <input
        type="checkbox"
        name={desc.name}
        data-testid={testId(desc.name)}
        checked={value === 1}
        onChange={(e) => onChange(e.target.checked ? 1 : 0)}
        onBlur={onBlur}
      />
      Yes
    </label>
  );
}

/** Render the widget for a descriptor (the §5.2 hand-written switch). */
export function FieldWidget(props: WidgetProps): JSX.Element {
  switch (props.desc.widget) {
    case "text":
      return <TextLikeInput {...props} type="text" />;
    case "number":
      return <TextLikeInput {...props} type="number" />;
    case "email":
      return <TextLikeInput {...props} type="email" />;
    case "tel":
      return <TextLikeInput {...props} type="tel" />;
    case "year-segmented":
      return <YearSegmented {...props} />;
    case "segmented":
      return <SegmentedEnum {...props} />;
    case "boolean-int":
      return <BooleanIntToggle {...props} />;
    default:
      return <TextLikeInput {...props} type="text" />;
  }
}
