export const UNSUPPORTED = Object.freeze({ unsupported: true });

export const RUNTIME_CONTRACT = Object.freeze({
  identity: Object.freeze({ required: true, members: Object.freeze({ findExecutable: 'required' }) }),
  install: Object.freeze({ required: true, members: Object.freeze({
    probeVersion: 'required',
    install: 'optional',
    installNotice: 'optional',
    installsToLocalBin: 'optional',
    dailyUpgradePrompt: 'optional',
    uninstall: 'optional',
    postUpgradeSync: 'optional',
  }) }),
  auth: Object.freeze({ required: true, members: Object.freeze({ checkAuth: 'required' }) }),
  launch: Object.freeze({ required: true, members: Object.freeze({ prepare: 'required' }) }),
  input: Object.freeze({ required: true, members: Object.freeze({ bracketedPaste: 'required' }) }),
});
