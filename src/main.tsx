import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { BookProvider } from "./store";
import "./styles.css";

// 防止把图片拖到窗口任意位置时，webview 把它当成页面直接打开
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BookProvider>
      <App />
    </BookProvider>
  </React.StrictMode>,
);
