import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "rawline-webfont/400.css";
import "rawline-webfont/500.css";
import "rawline-webfont/600.css";
import "rawline-webfont/700.css";
import "rawline-webfont/800.css";
import "rawline-webfont/900.css";
import "./styles.css";
import "./theme.css";
import "./theme-polish.css";
import "./compact.css";
import "./dark.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
