// Marcador da ação "Novo andar" do composer do chat (igual ao do Maestri nativo): vai no início do prompt e o agente,
// ao ver `<maestri-create-floor skill="maestri-workspace" />`, cria o andar com `maestri floor create` (skill maestri-workspace).
export const FLOOR_MARKER = '<maestri-create-floor skill="maestri-workspace" />';

export const withFloorMarker = (text: string) => `${FLOOR_MARKER}\n${text}`;

// Separa o marcador do texto (para mostrar um chip no histórico em vez do XML)
export function splitFloorMarker(text: string): { marker: boolean; rest: string } {
  const t = text.trimStart();
  return t.startsWith(FLOOR_MARKER) ? { marker: true, rest: t.slice(FLOOR_MARKER.length).replace(/^\s*\n?/, "") } : { marker: false, rest: text };
}
