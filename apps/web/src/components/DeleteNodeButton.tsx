"use client";

import React from "react";
import { useReactFlow } from "@xyflow/react";
import { Trash2 } from "lucide-react";
import { useConfirm } from "./ConfirmProvider";

export default function DeleteNodeButton({ id }: { id: string }) {
  const { deleteElements } = useReactFlow();
  const confirm = useConfirm();

  return (
    <button
      onClick={async () => {
        if (await confirm({ title: "Apagar nó", message: "Apagar este nó para todos os usuários?", confirmLabel: "Apagar", danger: true })) deleteElements({ nodes: [{ id }] });
      }}
      className="p-1 hover:bg-white/10 rounded text-slate-400 hover:text-rose-400 transition"
      title="Apagar nó"
      aria-label="Apagar nó"
    >
      <Trash2 className="h-3 w-3" />
    </button>
  );
}
