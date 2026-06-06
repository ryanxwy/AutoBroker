/**
 * FormBoundary — the graceful-degrade error boundary. If the SchemaForm
 * throws (a missing widget, a broken render), fall back to a plain-text dump of
 * the raw suspend spec (SchemaFormFallback) instead of a blank rail. Carries on
 * the legacy fallback discipline (SchemaForm.tsx:875-924).
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  spec: Record<string, unknown> | null;
  children: ReactNode;
}
interface State {
  failed: boolean;
}

export class FormBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console; the fallback below keeps the user unblocked.
    console.error("IntakeForm render failed — falling back to text spec.", error, info);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="gate-card" data-testid="schema-form-fallback" role="alert">
          <strong>Form could not render — raw request below.</strong>
          <pre className="muted" style={{ whiteSpace: "pre-wrap" }}>
            {JSON.stringify(this.props.spec ?? {}, null, 2)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
