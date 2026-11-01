import { Component, type ReactNode } from "react";
import { Button } from "@cutucircuits/ui";
export class EditorBoundary extends Component<
  { children: ReactNode; onSource: () => void },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div className="center-state">
          <h2>The native editor could not open</h2>
          <p>{this.state.error.message}</p>
          <Button className="control-button" onClick={this.props.onSource}>
            Open native source
          </Button>
        </div>
      );
    return this.props.children;
  }
}
