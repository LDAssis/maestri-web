// Relógio das contas (expiração de sessões e convites); os testes avançam `offset` em vez de esperar.
export const clock = {
  offset: 0,
  now(): number {
    return Date.now() + clock.offset;
  },
};
