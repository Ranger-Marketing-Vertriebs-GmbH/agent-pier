export class AssistantDrafts {
  constructor() {
    this.values = new Map();
  }
  get(id) {
    return this.values.get(id)?.text || "";
  }
  set(id, text) {
    if (this.get(id) !== text)
      this.values.set(id, { ...this.values.get(id), text, clientRequestId: null });
  }
  teamAllowed(id) {
    return this.values.get(id)?.teamAllowed === true;
  }
  allowTeam(id, allowed) {
    const value = { ...this.values.get(id), text: this.get(id), clientRequestId: null };
    if (allowed) value.teamAllowed = true;
    else delete value.teamAllowed;
    this.values.set(id, value);
  }
  delivery(id) {
    const value = this.values.get(id) || { text: "" };
    value.clientRequestId ||= crypto.randomUUID();
    this.values.set(id, value);
    return { ...value };
  }
  acknowledge(id, clientRequestId) {
    if (this.values.get(id)?.clientRequestId !== clientRequestId) return false;
    this.clear(id);
    return true;
  }
  clear(id) {
    this.values.delete(id);
  }
}
