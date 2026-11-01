import {Select} from "@base-ui/react/select";
import Icon from "@cutucircuits/ui/icon";

export interface SettingsSelectProps {
  readonly value: string;
  readonly options: readonly {value: string; label: string; disabled?: boolean}[];
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly "aria-label": string;
}

/** Shared settings dropdown: keyboard navigation, selected state and a portaled Codex-style surface. */
export default function SettingsSelect(props: SettingsSelectProps) {
  const {value, options, onValueChange, disabled} = props;
  return (
    <Select.Root
      value={value}
      items={options}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      disabled={disabled}
      modal={false}
    >
      <Select.Trigger aria-label={props["aria-label"]} className="cutucircuits-settings-select">
        <Select.Value className="min-w-0 truncate" />
        <Select.Icon className="shrink-0">
          <Icon name="chevron-down" size="xs" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner align="end" sideOffset={4} alignItemWithTrigger={false} className="z-50">
          <Select.Popup className="cutucircuits-select-popup">
            {options.map((option) => (
              <Select.Item key={option.value} value={option.value} disabled={option.disabled} className="cutucircuits-select-option">
                <Select.ItemText className="min-w-0 flex-1 break-words">{option.label}</Select.ItemText>
                <Select.ItemIndicator className="shrink-0">
                  <Icon name="check" size="xs" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}
