/// <reference types="vite/client" />

declare module 'troika-three-text' {
  export function configureTextBuilder(config: {
    defaultFontURL?: string;
    unicodeFontsURL?: string;
    useWorker?: boolean;
  }): void;
}
