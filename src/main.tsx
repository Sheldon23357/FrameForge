import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@xyflow/react/dist/style.css';
import './styles.css';
import App from './App';
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    if (this.state.error)
      return (
        <div className="boot-screen">
          <h2>界面遇到一个问题</h2>
          <p>{this.state.error}</p>
          <button className="button" onClick={() => location.reload()}>
            重新加载并恢复自动保存
          </button>
        </div>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
