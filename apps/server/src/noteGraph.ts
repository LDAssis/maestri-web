type Obj = Record<string, any>;

// Alcance de notas a partir de um nó: vizinhos diretos + cadeias de notas + páginas de fichários ligados.
// Notas guardadas em fichário (data.stackId) só aparecem como páginas do fichário, nunca soltas.
export interface Reach {
  node: Obj;
  // título/id do nó-mãe (nota ou fichário pelo qual a nota foi alcançada); null = ligada direto ao nó
  parent: Obj | null;
  stack: Obj | null;
}

export function reachNotes(nodes: Obj[], edges: Obj[], meId: string) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adj = (id: string) =>
    edges
      .filter((e) => e.source === id || e.target === id)
      .map((e) => byId.get(e.source === id ? e.target : e.source))
      .filter((n): n is Obj => !!n && n.id !== meId);
  const notes: Reach[] = [];
  const stacks: Obj[] = [];
  const seen = new Set<string>([meId]);
  const queue: { node: Obj; parent: Obj | null }[] = [];
  for (const n of adj(meId)) {
    if ((n.type === "stickyNote" && !n.data?.stackId) || n.type === "noteStack") queue.push({ node: n, parent: null });
  }
  while (queue.length) {
    const { node, parent } = queue.shift()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.type === "noteStack") {
      stacks.push(node);
      for (const page of nodes.filter((p) => p.type === "stickyNote" && p.data?.stackId === node.id)) {
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        notes.push({ node: page, parent: node, stack: node });
      }
    } else notes.push({ node, parent, stack: null });
    for (const n of adj(node.id)) {
      if (seen.has(n.id)) continue;
      if ((n.type === "stickyNote" && !n.data?.stackId) || n.type === "noteStack") queue.push({ node: n, parent: node });
    }
  }
  return { notes, stacks };
}
