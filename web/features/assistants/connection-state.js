// Agents and the connection list arrive in one response, so an agent whose
// connection is absent from it lost that connection (for example by deletion).
export function connectionMissing(assistant, models = []) {
  return !!assistant && !models.some((m) => m.id === assistant.model?.connectionId);
}
