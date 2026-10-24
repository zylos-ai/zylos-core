/** No global-session lifecycle exists. Every operation must name its target. */
export class RuntimeAdapter {
  constructor(options = {}) { this.options = options; }
  get runtimeId() { throw new Error('runtimeId must be implemented'); }
  async checkAuth() { return {status:'uncertain', reason:'not_implemented'}; }
}
