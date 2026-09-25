import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./theme.css";
import "./theme-polish.css";
import "./compact.css";
import "./pdf-modal.css";
import "./focus.css"; // por último: motor de scroll/foco ultraleve
import "./mobile.css";


ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
