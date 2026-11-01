// Adapted from assistant-ui's MIT-licensed Elements StreamingText standalone component:
// https://github.com/assistant-ui/assistant-ui/blob/main/packages/ui/src/components/react/assistant-ui/elements/streaming-text.tsx
import {cn} from "@cutucircuits/ui/cn";

export interface StreamingTextProps {
  readonly text: string;
  readonly streaming: boolean;
  readonly className?: string;
}

/** Shared word fade, two-word blue tail and pulsing caret for incrementally changing text. */
export default function StreamingText(props: StreamingTextProps) {
  const {text, streaming, className} = props;
  const words = text.split(" ");
  return (
    <p data-slot="streaming-text" className={cn("text-sm leading-relaxed text-pretty", className)}>
      {words.map((word, index) => (
        <span key={index} className="cutucircuits-stream-word">
          <span className={cn("cutucircuits-stream-word-ink", streaming && words.length - 1 - index < 2 && "cutucircuits-stream-fresh")}>{word}</span>
          {index < words.length - 1 ? " " : ""}
        </span>
      ))}
      {streaming && text.length > 0 && <span aria-hidden className="cutucircuits-stream-caret" />}
    </p>
  );
}
