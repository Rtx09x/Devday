import {Slider as BaseSlider} from "@base-ui/react/slider";
import {cn} from "@cutucircuits/ui/cn";

export interface SliderProps {
  readonly label: string;
  readonly value: number;
  readonly valueText?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onValueChange: (value: number) => void;
}

/** Thick settings slider with a value readout and accessible pointer/keyboard controls. */
export default function Slider(props: SliderProps) {
  const {label, value, valueText = String(value), min = 0, max = 100, step = 1, disabled, className, onValueChange} = props;

  return (
    <BaseSlider.Root
      className={cn("w-56 max-w-full data-disabled:opacity-50", className)}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={onValueChange}
    >
      <div aria-hidden="true" className="text-right text-xs leading-4 tabular-nums text-ink-muted">
        {valueText}
      </div>
      <BaseSlider.Control className="relative flex h-8 w-full touch-none cursor-pointer items-center select-none data-disabled:cursor-default">
        <BaseSlider.Track className="relative h-3 w-full rounded-full bg-border-muted">
          <BaseSlider.Indicator className="rounded-full bg-accent" />
          <BaseSlider.Thumb
            aria-label={label}
            getAriaValueText={() => valueText}
            className="size-5 rounded-full border-2 border-accent bg-white outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent-focus/60 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface"
          />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
