import { Component } from "react";

// 页面渲染出错时给出可理解的提示，而不是整页空白。
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Open Medical 页面出错", error, info?.componentStack);
  }
  componentDidUpdate(previous) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <main className="workspace-main om-error-boundary" role="alert">
      <h2>这个页面暂时无法显示</h2>
      <p>已保存的患者和任务资料不受影响。可以重新加载页面，或切换到其他页面后再回来。</p>
      <div className="toolbar-actions">
        <button className="primary" onClick={() => window.location.reload()}>重新加载</button>
        <button className="secondary" onClick={() => this.setState({ error: null })}>再试一次</button>
      </div>
    </main>;
  }
}
