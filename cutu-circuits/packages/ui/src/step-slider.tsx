import {useRef, useState} from "react";
import type {CSSProperties} from "react";

export interface StepSliderProps {
  readonly label: string;
  readonly value: number;
  readonly maximum: number;
  readonly valueText: string;
  readonly choices?: readonly {label: string; disabled?: boolean}[];
  readonly disabled?: boolean;
  readonly onChange: (value: number) => void;
}

/** The original CutuCircuits power slider, including snapping, disabled steps, focused wheel input and pointer capture. */
export default function StepSlider(props: StepSliderProps) {
  const {label, value, maximum, valueText, choices, disabled, onChange} = props;
  const track = useRef<HTMLDivElement | null>(null);
  const wheelTime = useRef(0);
  const [dragging, setDragging] = useState(false);
  const available = Array.from({length: maximum + 1}, (_, index) => index).filter((index) => !choices?.[index]?.disabled);
  const blocked = disabled || !available.length;
  const fraction = (index: number) => (maximum ? index / maximum : 0.5);
  const change = (index: number | undefined) => {
    if (!blocked && index !== undefined && available.includes(index) && index !== value) onChange(index);
  };
  const advance = (direction: number) => change(direction > 0 ? available.find((index) => index > value) : available.findLast((index) => index < value));
  const pick = (clientX: number) => {
    if (blocked || !track.current) return;
    const box = track.current.getBoundingClientRect();
    const next = Math.max(0, Math.min(1, (clientX - box.left - 14) / Math.max(1, box.width - 28)));
    change(available.reduce((best, index) => (Math.abs(fraction(index) - next) < Math.abs(fraction(best) - next) ? index : best)));
  };
  return (
    <div
      className="cutucircuits-power"
      data-dragging={dragging && !blocked}
      data-full={value === maximum}
      data-pct={fraction(value) * 100}
      data-disabled={blocked}
      style={{"--step-progress": fraction(value)} as CSSProperties}
    >
      <div className="cutucircuits-power-root">
        <div
          className="cutucircuits-power-track"
          ref={(node) => {
            track.current = node;
            if (!node) return;
            const wheel = (event: WheelEvent) => {
              if (blocked || !node.contains(document.activeElement)) return;
              event.preventDefault();
              if (Math.abs(event.deltaY) < 1 || performance.now() - wheelTime.current < 120) return;
              wheelTime.current = performance.now();
              advance(event.deltaY < 0 ? 1 : -1);
            };
            node.addEventListener("wheel", wheel, {passive: false});
            return () => {
              node.removeEventListener("wheel", wheel);
              track.current = null;
            };
          }}
        >
          <div className="cutucircuits-power-fill" />
          <div className="cutucircuits-power-ticks">
            {Array.from({length: maximum + 1}, (_, index) => (
              <button
                key={index}
                type="button"
                tabIndex={-1}
                className="cutucircuits-power-tick"
                style={{"--tick": fraction(index)} as CSSProperties}
                data-selected={index === value}
                aria-label={choices?.[index]?.label ?? `Step ${index + 1}`}
                title={choices?.[index]?.label ?? `Step ${index + 1}`}
                disabled={blocked || choices?.[index]?.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  change(index);
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="cutucircuits-power-hit"
            role="slider"
            disabled={blocked}
            aria-valuemin={0}
            aria-valuemax={maximum}
            aria-valuenow={value}
            aria-valuetext={valueText}
            aria-label={label}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Home") change(available[0]);
              else if (event.key === "End") change(available.at(-1));
              else advance(["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1);
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || blocked) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
              pick(event.clientX);
            }}
            onPointerMove={(event) => {
              if (dragging) pick(event.clientX);
            }}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onLostPointerCapture={() => setDragging(false)}
          />
        </div>
        <span className="cutucircuits-power-thumb" />
      </div>
    </div>
  );
}
