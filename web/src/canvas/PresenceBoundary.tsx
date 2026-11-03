// Other people's presence is drawn from what they sent. If drawing it ever throws, only that layer
// disappears (until the next presence update), never the whole editor.

import { Component, type ReactNode } from "react";
import { useCollab } from "../collab";

export class PresenceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  private off: (() => void) | null = null;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.error("presence layer failed", err);
  }

  componentDidMount() {
    // New presence may be well-formed again.
    this.off = useCollab.subscribe((s, prev) => {
      if (this.state.failed && s.peers !== prev.peers) this.setState({ failed: false });
    });
  }

  componentWillUnmount() {
    this.off?.();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
