import { createContext } from "react";

// Envia uma op ao servidor (WS do projeto); usado por nós que mexem em posição/arestas fora do updateNodeData
export type SendOp = (op: { kind: string; [k: string]: unknown }) => void;
export const CanvasOpsContext = createContext<SendOp>(() => {});
