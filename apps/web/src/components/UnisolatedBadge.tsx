import React from "react";
import { ShieldAlert } from "lucide-react";

// Projeto com pasta externa: o terminal roda como root, sem o isolamento por usuário do SO
export default function UnisolatedBadge() {
  return (
    <span
      title="Este projeto usa uma pasta externa e seus terminais rodam como root, sem isolamento no sistema operacional. Os agentes dele podem acessar outros arquivos do servidor."
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-px text-[9px] font-normal text-amber-300"
    >
      <ShieldAlert aria-hidden className="h-2.5 w-2.5" />
      sem isolamento
    </span>
  );
}
