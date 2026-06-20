import { forwardRef, useEffect, useRef, useState, type ForwardedRef, type MutableRefObject } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { CalendarDays } from "lucide-react";

interface DateFieldProps {
  id?: string;
  name?: string;
  value: string;
  label: string;
  disabled?: boolean;
  placeholder?: string;
  ariaInvalid?: boolean | "true" | "false";
  onChange: (value: string) => void;
}

export const DateField = forwardRef<HTMLInputElement, DateFieldProps>(function DateField({
  id,
  name,
  value,
  label,
  disabled = false,
  placeholder = "YYYY-MM-DD",
  ariaInvalid = false,
  onChange
}, forwardedRef) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedDate = parseDateValue(value);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        inputRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="date-field" ref={rootRef}>
      <input
        id={id}
        name={name}
        ref={(node) => assignInputRef(node, inputRef, forwardedRef)}
        disabled={disabled}
        aria-label={label}
        aria-invalid={ariaInvalid}
        inputMode="numeric"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="date-trigger"
        aria-label={`打开${label}日历`}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarDays size={15} />
      </button>
      {open ? (
        <div className="date-popover" role="dialog" aria-label={`${label}日期选择`}>
          <DayPicker
            mode="single"
            selected={selectedDate}
            month={selectedDate}
            captionLayout="dropdown"
            onSelect={(date) => {
              if (!date) return;
              onChange(formatDateValue(date));
              setOpen(false);
              window.requestAnimationFrame(() => inputRef.current?.focus());
            }}
          />
        </div>
      ) : null}
    </div>
  );
});

function assignInputRef(
  node: HTMLInputElement | null,
  inputRef: MutableRefObject<HTMLInputElement | null>,
  forwardedRef: ForwardedRef<HTMLInputElement>
) {
  inputRef.current = node;
  if (typeof forwardedRef === "function") {
    forwardedRef(node);
  } else if (forwardedRef) {
    forwardedRef.current = node;
  }
}

function parseDateValue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function formatDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
