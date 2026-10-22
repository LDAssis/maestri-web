import { createContext } from "react";

// Troca o andar em exibição no canvas (usado pelo indicador de arestas entre andares)
export const FloorNavContext = createContext<(floor: string) => void>(() => {});
