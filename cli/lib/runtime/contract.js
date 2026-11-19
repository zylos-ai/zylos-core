export const UNSUPPORTED = Object.freeze({ unsupported: true });

export const RUNTIME_CONTRACT = Object.freeze({
  auth: Object.freeze({ required: true, members: Object.freeze({ checkAuth: 'required' }) }),
  launch: Object.freeze({ required: true, members: Object.freeze({ prepare: 'required' }) }),
  input: Object.freeze({ required: true, members: Object.freeze({ bracketedPaste: 'required' }) }),
});
