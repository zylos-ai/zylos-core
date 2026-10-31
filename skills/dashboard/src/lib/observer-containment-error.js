export class ObserverContainmentError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ObserverContainmentError';
    this.code = code;
  }
}
