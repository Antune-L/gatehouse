import React from "react";
import ReactDOM from "react-dom/client";
import "@/lib/i18n";
import "./styles.css";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useStore } from "@/store";

void useStore.getState().initBackend();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  </React.StrictMode>
);
